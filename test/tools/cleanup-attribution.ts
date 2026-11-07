import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
} from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { powerShellArgs } from "../powershell.ts";

export type AttributionRunner = (
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => { status: number | null; stdout: string; stderr?: string; error?: Error };
export type CleanupInspector = (
  root: string,
  path: string,
  run: AttributionRunner,
) => unknown;

// Every collection and string is bounded before it is serialized, so the line stays valid JSON.
const MAX_LISTED_ENTRIES = 30;
const MAX_PROBED_ENTRIES = 500;
const MAX_PROBE_FAILURES = 20;
const MAX_PROCESSES = 20;
const COMMAND_CHARS = 100;
const TEXT_CHARS = 1_000;
const MAX_EVIDENCE_CHARS = 12_000;

// Handle cannot see every holder (a working directory, a file system filter driver), so name the candidates.
export const HOST_EVIDENCE = String.raw`
$root = $env:FORGE_CLEANUP_ROOT
# The cap is an environment variable only so a test can force it small.
$cap = 300
if ($env:FORGE_CLEANUP_PROCESS_CAP) { $cap = [int]$env:FORGE_CLEANUP_PROCESS_CAP }
$data = @{}
try {
  $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  $names = @{}
  foreach ($item in $all) { $names[[int]$item.ProcessId] = $item.Name }
  # Flag and sort root-named processes here, before the cap, so a busy runner cannot push the holder out.
  $matched = @($all | Where-Object {
    $_.Name -match '^(git|bun|node|bash|sh|conhost|codex|claude)\.exe$' -or ([string]$_.CommandLine).IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0
  } | ForEach-Object {
    $line = [string]$_.CommandLine
    [pscustomobject]@{ pid = $_.ProcessId; parent = $_.ParentProcessId; parentName = $names[[int]$_.ParentProcessId]; parentAlive = $names.ContainsKey([int]$_.ParentProcessId); name = $_.Name; created = [string]$_.CreationDate; matchesRoot = ($line.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0); command = $line.Substring(0, [Math]::Min(200, $line.Length)) }
  })
  $data.processesMatched = $matched.Count
  $data.processes = @($matched | Sort-Object @{ Expression = { if ($_.matchesRoot) { 0 } elseif ($_.name -eq 'conhost.exe') { 1 } else { 2 } } }, pid | Select-Object -First $cap)
} catch { $data.processError = $_.Exception.Message }
$out = ''
try { $out = (& fltmc.exe filters | Out-String).Trim(); if ($LASTEXITCODE -ne 0) { $data.filterError = "fltmc filters exited $($LASTEXITCODE): $out" } else { $data.filters = $out } } catch { $data.filterError = $_.Exception.Message }
try { $out = (& fltmc.exe instances -v $root.Substring(0, 2) | Out-String).Trim(); if ($LASTEXITCODE -ne 0) { $data.volumeError = "fltmc instances exited $($LASTEXITCODE): $out" } else { $data.volume = $out } } catch { $data.volumeError = $_.Exception.Message }
try { $data.defender = Get-MpComputerStatus -ErrorAction Stop | Select-Object RealTimeProtectionEnabled, AntivirusEnabled } catch { $data.defenderError = 'Defender state unavailable' }
try { $data.search = (Get-Service WSearch -ErrorAction Stop).Status.ToString() } catch { $data.searchError = 'Search service state unavailable' }
$data | ConvertTo-Json -Depth 4 -Compress
`;

// Read-only. A file is opened for read and renamed onto itself: the rename asks for delete access,
// so a holder that allows reads but denies delete sharing fails it. (A directory cannot be renamed
// onto itself, so it is only statted.) A delete-pending or locked entry names a nested holder.
function treeEvidence(root: string) {
  const probeFailures: { path: string; code: string | undefined }[] = [];
  let probeFailuresOmitted = 0;
  let entries: ReturnType<typeof listTree>;
  try {
    entries = listTree(root);
  } catch (error) {
    return { probeFailures, scanError: String(error) };
  }
  const probed = entries.slice(0, MAX_PROBED_ENTRIES);
  for (const entry of probed) {
    const path = join(entry.parentPath, entry.name);
    try {
      if (entry.isDirectory()) statSync(path);
      else {
        closeSync(openSync(path, "r"));
        renameSync(path, path);
      }
    } catch (error) {
      if (probeFailures.length < MAX_PROBE_FAILURES)
        probeFailures.push({
          path: relative(root, path),
          code: (error as NodeJS.ErrnoException).code,
        });
      else probeFailuresOmitted++;
    }
  }
  const remaining = entries
    .slice(0, MAX_LISTED_ENTRIES)
    .map((entry) => relative(root, join(entry.parentPath, entry.name)));
  return {
    remainingCount: entries.length,
    remaining,
    remainingOmitted: entries.length - remaining.length,
    probesSkipped: entries.length - probed.length,
    probeFailures,
    probeFailuresOmitted,
  };
}

function listTree(root: string) {
  return readdirSync(root, { recursive: true, withFileTypes: true });
}

const clip = (value: unknown, max: number): unknown =>
  typeof value === "string" && value.length > max ? value.slice(0, max) : value;

// PowerShell already flags root-named processes; they and conhost go first so the cap never drops the likely holder.
function boundHost(host: unknown) {
  if (typeof host !== "object" || host === null || Array.isArray(host))
    return { host };
  const record = host as Record<string, unknown>;
  const bounded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record))
    if (key !== "processes") bounded[key] = clip(value, TEXT_CHARS);
  const processes: unknown[] = Array.isArray(record.processes)
    ? record.processes
    : [];
  const priority = (item: unknown) => {
    const { name, matchesRoot } = (item ?? {}) as Record<string, unknown>;
    return matchesRoot === true || String(name).toLowerCase() === "conhost.exe";
  };
  const ordered = [
    ...processes.filter(priority),
    ...processes.filter((item) => !priority(item)),
  ].slice(0, MAX_PROCESSES);
  if (Array.isArray(record.processes))
    bounded.processes = ordered.map((item) =>
      typeof item === "object" && item !== null
        ? Object.fromEntries(
            Object.entries(item).map(([key, value]) => [
              key,
              clip(value, COMMAND_CHARS),
            ]),
          )
        : item,
    );
  const matched =
    typeof record.processesMatched === "number"
      ? record.processesMatched
      : processes.length;
  return {
    host: bounded,
    processesOmitted: Math.max(matched, processes.length) - ordered.length,
  };
}

// Short scalars and the probe results are the evidence that matters most, so the fallback keeps them.
const FALLBACK_SCALAR_CHARS = 300;
function tooLarge(evidence: unknown, length: number) {
  const kept: Record<string, unknown> = { evidenceTooLarge: length };
  if (typeof evidence === "object" && evidence !== null)
    for (const [key, value] of Object.entries(evidence))
      if (
        key === "probeFailures" ||
        value === null ||
        typeof value === "number" ||
        typeof value === "boolean" ||
        (typeof value === "string" && value.length <= FALLBACK_SCALAR_CHARS)
      )
        kept[key] = value;
  return kept;
}

// Never slice the JSON text: a cut line is invalid and drops the later fields.
function serialize(evidence: unknown): string {
  try {
    const text = JSON.stringify(evidence);
    return text.length <= MAX_EVIDENCE_CHARS
      ? text
      : JSON.stringify(tooLarge(evidence, text.length));
  } catch (failure) {
    return JSON.stringify({ inspectError: String(failure) });
  }
}

// Diagnostic only, never a retry: it says whether a hold was transient. The caller still throws
// the original error, so a failing cleanup keeps failing and nothing is masked.
export const SECOND_ATTEMPT_DELAY_MS = 500;
export type CleanupSleep = (ms: number) => void;
const blockingSleep: CleanupSleep = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

function secondAttempt(cleanup: () => void, sleep: CleanupSleep) {
  const started = performance.now();
  sleep(SECOND_ATTEMPT_DELAY_MS);
  let outcome: string;
  try {
    cleanup();
    outcome = "removed";
  } catch (failure) {
    outcome = String((failure as NodeJS.ErrnoException)?.code ?? failure);
  }
  return {
    secondAttempt: outcome,
    secondAttemptMs: Math.round(performance.now() - started),
  };
}

function windowsEvidence(
  root: string,
  path: string,
  run: AttributionRunner,
): unknown {
  const evidence: Record<string, unknown> = {
    root,
    errorPath: path,
    errorIsRoot: resolve(path) === resolve(root),
    rootExists: existsSync(root),
    ...treeEvidence(root),
  };
  try {
    const result = run("powershell.exe", powerShellArgs(HOST_EVIDENCE), {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
      env: { ...process.env, FORGE_CLEANUP_ROOT: root },
    });
    if (result.error || result.status !== 0)
      throw (
        result.error ??
        new Error(`status ${result.status}: ${result.stderr || result.stdout}`)
      );
    Object.assign(evidence, boundHost(JSON.parse(result.stdout)));
  } catch (failure) {
    evidence.hostError = String(failure);
  }
  return evidence;
}

// Timing: the worst failure path is about 48 s (15 s host query, 3 x 10 s Handle runs, 0.5 s second
// attempt, plus the tree probe) against the 60 s hook timeout, so only about 12 s of margin is
// left. That margin is known and deliberately unchanged; do not add another slow step here.
export function cleanupAttribution(
  root: string,
  cleanup: () => void,
  run: AttributionRunner = spawnSync,
  {
    tool = process.env.FORGE_HANDLE_EXE,
    unavailable = process.env.FORGE_HANDLE_UNAVAILABLE,
    inspect = windowsEvidence,
    // Only a unit test of this helper injects a no-op; every real cleanup waits the full delay.
    sleep = blockingSleep,
  }: {
    tool?: string;
    unavailable?: string;
    inspect?: CleanupInspector;
    sleep?: CleanupSleep;
  } = {},
): void {
  try {
    cleanup();
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException;
    if (
      process.platform === "win32" &&
      ["EBUSY", "EPERM"].includes(error?.code ?? "")
    ) {
      let evidence: unknown;
      // Handle-less runs skip the host query too, so they never execute a tool.
      if (tool && !unavailable)
        try {
          evidence = inspect(root, error.path ?? root, run);
        } catch (failure) {
          evidence = { inspectError: String(failure) };
        }
      const snapshots = [
        ...new Set([error.path ?? root, root, basename(root)]),
      ].map((path) => {
        const at = new Date().toISOString();
        try {
          if (unavailable) throw new Error(unavailable);
          if (!tool) throw new Error("handle unavailable: not configured");
          const result = run(
            tool,
            ["-accepteula", "-nobanner", "-a", "-u", "-v", path],
            { encoding: "utf8", timeout: 10_000, windowsHide: true },
          );
          return {
            path,
            at,
            status: result.status,
            output: result.stdout,
            ...(result.error || result.status !== 0
              ? {
                  failure: `attribution failed: ${result.error?.message ?? (result.stderr || result.stdout)}`,
                }
              : {}),
          };
        } catch (failure) {
          return {
            path,
            at,
            status: null,
            failure: `attribution failed: ${String(failure)}`,
          };
        }
      });
      try {
        // Last, so the attribution above saw the state the failure left behind. It runs for every
        // run, with or without host evidence, and inside this try so that nothing it throws can
        // replace the original error.
        const base =
          evidence === undefined
            ? {}
            : typeof evidence === "object" && evidence !== null
              ? evidence
              : { inspected: evidence };
        // Evidence comes first so the attribution JSON stays the last line of the message.
        error.message += `\nCleanup evidence: ${serialize({ ...base, ...secondAttempt(cleanup, sleep) })}`;
      } catch {
        // The original cleanup error is rethrown below even if its message cannot be extended.
      }
      // Its own try, so a second attempt that throws still leaves the attribution line.
      try {
        error.message += `\nCleanup attribution: ${JSON.stringify(snapshots)}`;
      } catch {
        // The original cleanup error is rethrown below even if its message cannot be extended.
      }
    }
    throw cause;
  }
}
