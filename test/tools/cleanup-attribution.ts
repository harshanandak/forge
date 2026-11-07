import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
} from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
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

const MAX_LISTED_ENTRIES = 50;
const MAX_EVIDENCE_CHARS = 12_000;

// Handle cannot see every holder (a working directory, a kernel filter), so name the candidates.
const HOST_EVIDENCE = String.raw`
$root = $env:FORGE_CLEANUP_ROOT
$data = @{}
try {
  $data.processes = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
    $_.Name -match '^(git|bun|node|bash|sh|conhost|codex|claude)\.exe$' -or ([string]$_.CommandLine).IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0
  } | Select-Object -First 60 | ForEach-Object {
    $line = [string]$_.CommandLine
    @{ pid = $_.ProcessId; parent = $_.ParentProcessId; name = $_.Name; created = [string]$_.CreationDate; command = $line.Substring(0, [Math]::Min(200, $line.Length)) }
  })
} catch { $data.processError = $_.Exception.Message }
try { $data.filters = (& fltmc.exe filters | Out-String).Trim() } catch { $data.filterError = $_.Exception.Message }
try { $data.volume = (& fltmc.exe instances -v $root.Substring(0, 2) | Out-String).Trim() } catch { $data.volumeError = $_.Exception.Message }
try { $data.defender = Get-MpComputerStatus -ErrorAction Stop | Select-Object RealTimeProtectionEnabled, AntivirusEnabled } catch { $data.defenderError = 'Defender state unavailable' }
try { $data.search = (Get-Service WSearch -ErrorAction Stop).Status.ToString() } catch { $data.searchError = 'Search service state unavailable' }
$data | ConvertTo-Json -Depth 4 -Compress
`;

// Read-only (a rename onto itself fails on directories): a delete-pending or locked entry fails the probe, so a nested holder is named.
function treeEvidence(root: string) {
  const remaining: string[] = [];
  const probeFailures: { path: string; code: string | undefined }[] = [];
  try {
    const entries = readdirSync(root, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      const path = join(entry.parentPath, entry.name);
      const name = relative(root, path);
      if (remaining.length < MAX_LISTED_ENTRIES) remaining.push(name);
      try {
        if (entry.isDirectory()) statSync(path);
        else closeSync(openSync(path, "r"));
      } catch (error) {
        probeFailures.push({
          path: name,
          code: (error as NodeJS.ErrnoException).code,
        });
      }
    }
    return { remainingCount: entries.length, remaining, probeFailures };
  } catch (error) {
    return { remaining, probeFailures, scanError: String(error) };
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
    evidence.host = JSON.parse(result.stdout) as unknown;
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
      // Evidence comes first so the attribution JSON stays the last line of the message.
      if (evidence !== undefined)
        error.message += `\nCleanup evidence: ${JSON.stringify(evidence).slice(0, MAX_EVIDENCE_CHARS)}`;
      error.message += `\nCleanup attribution: ${JSON.stringify(snapshots)}`;
    }
    throw cause;
  }
}
