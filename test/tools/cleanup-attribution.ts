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
const HOST_EVIDENCE = String.raw`
$root = $env:FORGE_CLEANUP_ROOT
$data = @{}
try {
  $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  $names = @{}
  foreach ($item in $all) { $names[[int]$item.ProcessId] = $item.Name }
  $data.processes = @($all | Where-Object {
    $_.Name -match '^(git|bun|node|bash|sh|conhost|codex|claude)\.exe$' -or ([string]$_.CommandLine).IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0
  } | Select-Object -First 300 | ForEach-Object {
    $line = [string]$_.CommandLine
    @{ pid = $_.ProcessId; parent = $_.ParentProcessId; parentName = $names[[int]$_.ParentProcessId]; parentAlive = $names.ContainsKey([int]$_.ParentProcessId); name = $_.Name; created = [string]$_.CreationDate; command = $line.Substring(0, [Math]::Min(200, $line.Length)) }
  })
} catch { $data.processError = $_.Exception.Message }
$out = ''
try { $out = (& fltmc.exe filters | Out-String).Trim(); if ($LASTEXITCODE -ne 0) { $data.filterError = "fltmc filters exited $LASTEXITCODE: $out" } else { $data.filters = $out } } catch { $data.filterError = $_.Exception.Message }
try { $out = (& fltmc.exe instances -v $root.Substring(0, 2) | Out-String).Trim(); if ($LASTEXITCODE -ne 0) { $data.volumeError = "fltmc instances exited $LASTEXITCODE: $out" } else { $data.volume = $out } } catch { $data.volumeError = $_.Exception.Message }
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

// Root-named processes and conhost come first, so the cap never drops the likely holder.
function boundHost(host: unknown, root: string) {
  if (typeof host !== "object" || host === null || Array.isArray(host))
    return { host };
  const record = host as Record<string, unknown>;
  const bounded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record))
    if (key !== "processes") bounded[key] = clip(value, TEXT_CHARS);
  const processes: unknown[] = Array.isArray(record.processes)
    ? record.processes
    : [];
  const needle = root.toLowerCase();
  const priority = (item: unknown) => {
    const { name, command } = (item ?? {}) as Record<string, unknown>;
    return (
      String(name).toLowerCase() === "conhost.exe" ||
      String(command).toLowerCase().includes(needle)
    );
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
  return { host: bounded, processesOmitted: processes.length - ordered.length };
}

// Never slice the JSON text: a cut line is invalid and drops the later fields.
function serialize(evidence: unknown): string {
  try {
    const text = JSON.stringify(evidence);
    return text.length <= MAX_EVIDENCE_CHARS
      ? text
      : JSON.stringify({ evidenceTooLarge: text.length });
  } catch (failure) {
    return JSON.stringify({ inspectError: String(failure) });
  }
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
    Object.assign(evidence, boundHost(JSON.parse(result.stdout), root));
  } catch (failure) {
    evidence.hostError = String(failure);
  }
  return evidence;
}

export function cleanupAttribution(
  root: string,
  cleanup: () => void,
  run: AttributionRunner = spawnSync,
  {
    tool = process.env.FORGE_HANDLE_EXE,
    unavailable = process.env.FORGE_HANDLE_UNAVAILABLE,
    inspect = windowsEvidence,
  }: { tool?: string; unavailable?: string; inspect?: CleanupInspector } = {},
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
        // Evidence comes first so the attribution JSON stays the last line of the message.
        if (evidence !== undefined)
          error.message += `\nCleanup evidence: ${serialize(evidence)}`;
        error.message += `\nCleanup attribution: ${JSON.stringify(snapshots)}`;
      } catch {
        // The original cleanup error is rethrown below even if its message cannot be extended.
      }
    }
    throw cause;
  }
}
