// [integration] Real local git repositories; Forge, GitHub and cleanup failures are PATH fixtures.
import {
  afterAll,
  afterEach,
  beforeEach,
  expect,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
import {
  spawn,
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { RepositoryFixtures } from "./lane-fixture.ts";
import { cleanupAttribution } from "./cleanup-attribution.ts";

setDefaultTimeout(60_000);
const repositories = new RepositoryFixtures<{ head: string; merge: string }>();
const script = resolve(import.meta.dirname, "../../tools/lane.ts");
const roots: string[] = [];
let gitBin: string | undefined;
afterAll(() => {
  const root = gitBin;
  if (root)
    cleanupAttribution(root, () =>
      rmSync(root, { recursive: true, force: true }),
    );
});
let testStartedAt = Date.now();
beforeEach(() => {
  testStartedAt = Date.now();
});
type DiagnosticRunner = (
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => { status: number | null; stdout: string; error?: Error };
const cleanupNativeSource = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class CleanupRestartManager {
  [StructLayout(LayoutKind.Sequential)]
  public struct UniqueProcess {
    public uint pid;
    public System.Runtime.InteropServices.ComTypes.FILETIME started;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct ProcessInfo {
    public UniqueProcess process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string name;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string service;
    public uint appType;
    public uint status;
    public uint session;
    [MarshalAs(UnmanagedType.Bool)] public bool restartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern uint RmStartSession(out uint session, uint flags, StringBuilder key);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern uint RmRegisterResources(uint session, uint files, string[] paths, uint apps, IntPtr processes, uint services, IntPtr names);
  [DllImport("rstrtmgr.dll")]
  static extern uint RmGetList(uint session, out uint needed, ref uint count, [In, Out] ProcessInfo[] processes, out uint reasons);
  [DllImport("rstrtmgr.dll")]
  static extern uint RmEndSession(uint session);
  static string stage;
  static void Check(uint code) {
    if (code != 0) throw new InvalidOperationException(stage + " native error " + code);
  }
  public static ProcessInfo[] Query(string path) {
    if (!System.IO.File.Exists(path)) return new ProcessInfo[0];
    uint session;
    stage = "RmStartSession";
    Check(RmStartSession(out session, 0, new StringBuilder(33)));
    try {
      stage = "RmRegisterResources";
      Check(RmRegisterResources(session, 1, new string[] { path }, 0, IntPtr.Zero, 0, IntPtr.Zero));
      uint needed, count = 0, reasons;
      stage = "RmGetList"; uint code = RmGetList(session, out needed, ref count, null, out reasons);
      if (code == 0) return new ProcessInfo[0];
      if (code != 234) Check(code);
      count = needed;
      ProcessInfo[] holders = new ProcessInfo[count];
      Check(RmGetList(session, out needed, ref count, holders, out reasons));
      Array.Resize(ref holders, (int)count);
      return holders;
    } finally { stage = "RmEndSession"; Check(RmEndSession(session)); }
  }
}
public static class CleanupDeleteProbe {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  public static bool CanOpenForDelete(string path) {
    // DELETE access, all sharing, OPEN_EXISTING, directory support; never delete-on-close.
    using (SafeFileHandle handle = CreateFileW(path, 0x00010000, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
      return !handle.IsInvalid;
    }
  }
}
`;
let cleanupAssembly:
  { root: string; path: string; failure?: Error } | undefined;
let cleanupCompilations = 0;
function cleanupNativeEnvironment(run: DiagnosticRunner = spawnSync) {
  if (run !== spawnSync) return process.env;
  if (!cleanupAssembly) {
    const root = mkdtempSync(join(tmpdir(), "forge-cleanup-native-"));
    cleanupAssembly = { root, path: join(root, "cleanup.dll") };
    cleanupCompilations += 1;
    try {
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Add-Type -ErrorAction Stop -OutputAssembly $env:FORGE_LANE_CLOSE_ASSEMBLY -TypeDefinition @'\n${cleanupNativeSource}\n'@`,
        ],
        {
          encoding: "utf8",
          timeout: 10_000,
          windowsHide: true,
          env: {
            ...process.env,
            FORGE_LANE_CLOSE_ASSEMBLY: cleanupAssembly.path,
          },
        },
      );
      if (result.error || result.status !== 0)
        throw new Error("Cleanup diagnostic assembly compilation failed");
    } catch {
      // Cache failure too: a diagnostic must not repeatedly invoke the compiler.
      cleanupAssembly.failure = new Error(
        "Cleanup diagnostic assembly compilation failed",
      );
    }
  }
  if (cleanupAssembly.failure) throw cleanupAssembly.failure;
  return { ...process.env, FORGE_LANE_CLOSE_ASSEMBLY: cleanupAssembly.path };
}
afterAll(() => {
  if (cleanupAssembly) {
    const { root } = cleanupAssembly;
    cleanupAttribution(root, () =>
      rmSync(root, { recursive: true, force: true }),
    );
  }
});
const cleanupDiagnosticCommand = String.raw`
$root = $env:FORGE_LANE_CLOSE_DIAGNOSTIC_ROOT
$data = @{ holders = @(); holderUnknown = $true; holderReason = 'Restart Manager returned no holders' }
try {
  Add-Type -ErrorAction Stop -Path $env:FORGE_LANE_CLOSE_ASSEMBLY
  $data.holders = @([CleanupRestartManager]::Query($env:FORGE_LANE_CLOSE_DIAGNOSTIC_PATH) | ForEach-Object { @{ pid = $_.process.pid; name = $_.name; appType = $_.appType } })
  if ($data.holders.Count -gt 0) { $data.holderUnknown = $false; $data.Remove('holderReason') }
} catch { $data.holders = @(); $data.holderUnknown = $true; $data.holderReason = $_.Exception.ToString() }
try { $data.defender = Get-MpComputerStatus -ErrorAction Stop | Select-Object RealTimeProtectionEnabled } catch { $data.defenderError = 'Defender state unavailable' }
try {
  $exclusions = @((Get-MpPreference -ErrorAction Stop).ExclusionPath)
  $data.defenderExclusions = @($exclusions | Where-Object { if ($_) { $excluded = [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\'); $root -like $excluded -or $root -like ($excluded + '\*') } })
  $data.underDefenderExclusion = $data.defenderExclusions.Count -gt 0
} catch { $data.exclusionError = 'Defender exclusions unavailable' }
$data | ConvertTo-Json -Depth 5 -Compress
`;
const cleanupEvidenceCommand = String.raw`
$root = $env:FORGE_LANE_CLOSE_DIAGNOSTIC_ROOT
$bin = Join-Path $root 'bin'
$data = @{ processes = @(); files = @(); gitExists = $null }
try {
  $pattern = $root.Replace('\', '\\').Replace("'", "\'").Replace('[', '[[]').Replace('%', '[%]').Replace('_', '[_]')
  $filter = "ExecutablePath LIKE '%$pattern%' OR CommandLine LIKE '%$pattern%'"
  $data.processes = @(Get-CimInstance Win32_Process -ErrorAction Stop -Filter $filter | Where-Object {
    ($_.ExecutablePath -and $_.ExecutablePath.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0) -or
    ($_.CommandLine -and $_.CommandLine.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0)
  } | ForEach-Object {
    @{ ProcessId = $_.ProcessId; ParentProcessId = $_.ParentProcessId; Name = $_.Name; ExecutablePath = $_.ExecutablePath;
       CommandLine = if ($null -ne $_.CommandLine) { $_.CommandLine.Substring(0, [Math]::Min(300, $_.CommandLine.Length)) } else { $null };
       CreationDate = if ($_.CreationDate) { $_.CreationDate.ToString('o') } else { $null } }
  })
} catch { $data.processQueryError = 'Win32_Process query failed' }
try {
  $data.gitExists = Test-Path -LiteralPath (Join-Path $bin 'git.exe') -PathType Leaf -ErrorAction Stop
  if ([IO.Directory]::Exists($bin)) {
    Add-Type -ErrorAction Stop -Path $env:FORGE_LANE_CLOSE_ASSEMBLY
    $data.files = @(Get-ChildItem -LiteralPath $bin -Force -ErrorAction Stop | ForEach-Object {
      @{ name = $_.Name; deleteOpenSucceeded = [CleanupDeleteProbe]::CanOpenForDelete($_.FullName) }
    })
  }
} catch { $data.filesQueryError = 'Bin delete-access query failed' }
$data | ConvertTo-Json -Depth 5 -Compress
`;
type CleanupEvidence = {
  processes: {
    ProcessId: number;
    ParentProcessId: number;
    Name: string;
    ExecutablePath: string | null;
    CommandLine: string | null;
    CreationDate: string | null;
  }[];
  files: { name: string; deleteOpenSucceeded: boolean }[];
  gitExists: boolean | null;
  processQueryError?: string;
  filesQueryError?: string;
};
function diagnoseCleanup(
  root: string,
  start: number,
  original: unknown,
  run: DiagnosticRunner = spawnSync,
): never {
  const failures: { path: string; code: string | undefined }[] = [];
  const fallback = {
    holders: [],
    holderUnknown: true,
    holderReason: "PowerShell diagnostic did not complete",
  };
  const report: Record<string, unknown> = {
    root,
    start,
    failures,
    host: fallback,
    processes: [],
    files: [],
    gitExists: null,
  };
  report.failedAtMs = Date.now() - start;
  try {
    const result = run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", cleanupEvidenceCommand],
      {
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
        env: {
          ...cleanupNativeEnvironment(run),
          FORGE_LANE_CLOSE_DIAGNOSTIC_ROOT: root,
        },
      },
    );
    if (result.error || result.status !== 0)
      throw new Error("Cleanup evidence query did not complete");
    const evidence = JSON.parse(result.stdout) as CleanupEvidence;
    report.processes = evidence.processes ?? [];
    report.files = evidence.files ?? [];
    report.gitExists = evidence.gitExists ?? null;
    if (evidence.processQueryError)
      report.processQueryError = evidence.processQueryError;
    if (evidence.filesQueryError)
      report.filesQueryError = evidence.filesQueryError;
  } catch {
    report.processQueryError = "Cleanup evidence query did not complete";
    report.filesQueryError = "Cleanup evidence query did not complete";
  }
  try {
    try {
      const options = { recursive: true, withFileTypes: true } as const;
      for (const entry of readdirSync(root, options)) {
        const path = join(entry.parentPath, entry.name);
        try {
          if (entry.isDirectory()) renameSync(path, path);
          else closeSync(openSync(path, "r"));
        } catch (error) {
          failures.push({ path, code: (error as NodeJS.ErrnoException).code });
        }
      }
    } catch (error) {
      report.scanError = String(error);
    }

    const args = [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      cleanupDiagnosticCommand,
    ];
    const result = run("powershell.exe", args, {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
      env: {
        ...cleanupNativeEnvironment(run),
        FORGE_LANE_CLOSE_DIAGNOSTIC_ROOT: root,
        FORGE_LANE_CLOSE_DIAGNOSTIC_PATH:
          (original as NodeJS.ErrnoException).path ?? root,
      },
    });
    report.systemExitCode = result.status;
    if (!result.error && result.status === 0)
      report.host = JSON.parse(result.stdout) as unknown;
  } catch {
    report.diagnosticError = "Cleanup diagnostic failed";
  }
  report.elapsedMs = Date.now() - start;
  try {
    console.error(JSON.stringify(report));
  } catch {
    // Reporting must not replace the cleanup error, even if stderr is unavailable.
  }
  throw original;
}
function cleanupRoot(
  root: string,
  start: number,
  remove = () => rmSync(root, { recursive: true, force: true }),
  run: DiagnosticRunner = spawnSync,
) {
  const bin = join(root, "bin");
  if (existsSync(bin))
    expect(readdirSync(bin).filter((name) => /\.exe$/i.test(name))).toEqual([]);
  try {
    cleanupAttribution(root, remove, run);
  } catch (error) {
    if (
      process.platform === "win32" &&
      ["EBUSY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")
    )
      diagnoseCleanup(root, start, error, run);
    throw error;
  }
}
afterEach(() => {
  for (const root of roots.splice(0)) cleanupRoot(root, testStartedAt);
});

type CleanupReport = CleanupEvidence & {
  root: string;
  elapsedMs: number;
  failures: { path: string; code: string }[];
  scanError?: string;
  diagnosticError?: string;
  systemExitCode?: number | null;
  host: {
    holders: { pid: number; name: string; appType: number }[];
    holderUnknown: boolean;
    holderReason?: string;
    defender?: { RealTimeProtectionEnabled: boolean };
    defenderExclusions?: string[];
    underDefenderExclusion?: boolean;
    defenderError?: string;
    exclusionError?: string;
  };
};
function cleanupReport(
  root: string,
  code: string,
  run: DiagnosticRunner,
  path?: string,
) {
  const original = Object.assign(new Error("injected cleanup failure"), {
    code,
    ...(path ? { path } : {}),
  });
  const messages: string[] = [];
  const log = spyOn(console, "error").mockImplementation((message: string) => {
    messages.push(message);
  });
  try {
    let caught: unknown;
    try {
      cleanupRoot(
        root,
        Date.now(),
        () => {
          throw original;
        },
        run,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught === original).toBe(true);
  } finally {
    log.mockRestore();
  }
  expect(messages.length).toBe(1);
  return messages[0]!;
}

function diagnosticRoot() {
  const root = mkdtempSync(join(tmpdir(), "holder-717-"));
  roots.push(root);
  return root;
}
function diagnosticResult(host: CleanupReport["host"]) {
  return { status: 0, stdout: JSON.stringify(host) };
}

test.skipIf(process.platform !== "win32")(
  "Restart Manager refuses directory registration before opening a session",
  () => {
    const root = diagnosticRoot();
    const env = cleanupNativeEnvironment();
    expect(cleanupNativeEnvironment().FORGE_LANE_CLOSE_ASSEMBLY).toBe(
      env.FORGE_LANE_CLOSE_ASSEMBLY,
    );
    expect(cleanupCompilations).toBe(1);
    expect(existsSync(env.FORGE_LANE_CLOSE_ASSEMBLY!)).toBe(true);
    const script =
      cleanupDiagnosticCommand.slice(
        0,
        cleanupDiagnosticCommand.indexOf(
          "  $data.holders = @([CleanupRestartManager]",
        ),
      ) +
      "  Write-Output ([CleanupRestartManager]::Query($env:FORGE_LANE_CLOSE_DIAGNOSTIC_PATH).Length)\n} catch { throw }";
    const started = performance.now();
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
        env: { ...env, FORGE_LANE_CLOSE_DIAGNOSTIC_PATH: root },
      },
    );
    console.info(
      `Restart Manager directory diagnostic: ${performance.now() - started} ms`,
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("0");
  },
  30_000,
);

test("cleanup diagnostic command registers the failing path and maps Restart Manager holders", () => {
  for (const script of [cleanupDiagnosticCommand, cleanupEvidenceCommand]) {
    expect(script).not.toContain("-TypeDefinition");
    expect(script).toContain(
      "Add-Type -ErrorAction Stop -Path $env:FORGE_LANE_CLOSE_ASSEMBLY",
    );
  }
  const command = (cleanupNativeSource + cleanupDiagnosticCommand).replace(
    /\s+/g,
    " ",
  );
  for (const fragment of [
    'DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)',
    "public UniqueProcess process;",
    "public uint pid;",
    "public string name;",
    "public uint appType;",
    "Check(RmStartSession(out session, 0, new StringBuilder(33)));",
    "Check(RmRegisterResources(session, 1, new string[] { path }, 0, IntPtr.Zero, 0, IntPtr.Zero));",
    "uint code = RmGetList(session, out needed, ref count, null, out reasons);",
    "if (code == 0) return new ProcessInfo[0]; if (code != 234) Check(code); count = needed;",
    "ProcessInfo[] holders = new ProcessInfo[count]; Check(RmGetList(session, out needed, ref count, holders, out reasons));",
    "Array.Resize(ref holders, (int)count); return holders;",
    'finally { stage = "RmEndSession"; Check(RmEndSession(session)); }',
    "$data.holders = @([CleanupRestartManager]::Query($env:FORGE_LANE_CLOSE_DIAGNOSTIC_PATH) | ForEach-Object { @{ pid = $_.process.pid; name = $_.name; appType = $_.appType } })",
    "if ($data.holders.Count -gt 0) { $data.holderUnknown = $false; $data.Remove('holderReason') }",
    "catch { $data.holders = @(); $data.holderUnknown = $true; $data.holderReason = $_.Exception.ToString() }",
  ])
    expect(command).toContain(fragment);
});

test("cleanup diagnostic command collects Defender protection state with an error fallback", () => {
  const command = cleanupDiagnosticCommand.replace(/\s+/g, " ");
  expect(command).toContain(
    "$data.defender = Get-MpComputerStatus -ErrorAction Stop | Select-Object RealTimeProtectionEnabled",
  );
  expect(command).toContain(
    "catch { $data.defenderError = 'Defender state unavailable' }",
  );
});

test("cleanup diagnostic command collects matching Defender exclusions with an error fallback", () => {
  const command = cleanupDiagnosticCommand.replace(/\s+/g, " ");
  for (const fragment of [
    "$root = $env:FORGE_LANE_CLOSE_DIAGNOSTIC_ROOT",
    "$exclusions = @((Get-MpPreference -ErrorAction Stop).ExclusionPath)",
    String.raw`$data.defenderExclusions = @($exclusions | Where-Object { if ($_) { $excluded = [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\'); $root -like $excluded -or $root -like ($excluded + '\*') } })`,
    "$data.underDefenderExclusion = $data.defenderExclusions.Count -gt 0",
    "catch { $data.exclusionError = 'Defender exclusions unavailable' }",
    "$data | ConvertTo-Json -Depth 5 -Compress",
  ])
    expect(command).toContain(fragment);
});

test.skipIf(process.platform !== "win32")(
  "cleanup evidence script queries processes and probes bin files through PowerShell",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-cleanup-evidence-[_%']-"));
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)", root],
      {
        stdio: "ignore",
        windowsHide: true,
      },
    );
    try {
      await once(child, "spawn");
      const bin = join(root, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "probe.txt"), "Cleanup evidence fixture.\n");
      const names = readdirSync(bin).sort();
      const env = cleanupNativeEnvironment();
      expect(cleanupNativeEnvironment().FORGE_LANE_CLOSE_ASSEMBLY).toBe(
        env.FORGE_LANE_CLOSE_ASSEMBLY,
      );
      expect(cleanupCompilations).toBe(1);
      expect(existsSync(env.FORGE_LANE_CLOSE_ASSEMBLY!)).toBe(true);
      const started = performance.now();
      const result = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", cleanupEvidenceCommand],
        {
          encoding: "utf8",
          timeout: 10_000,
          windowsHide: true,
          env: { ...env, FORGE_LANE_CLOSE_DIAGNOSTIC_ROOT: root },
        },
      );
      console.info(
        `Cleanup evidence diagnostic: ${performance.now() - started} ms`,
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      const evidence = JSON.parse(result.stdout) as CleanupEvidence;
      expect(Array.isArray(evidence.processes)).toBe(true);
      const holder = evidence.processes.find(
        (entry) => entry.ProcessId === child.pid,
      );
      expect(holder?.CommandLine).toContain(root);
      expect(Array.isArray(evidence.files)).toBe(true);
      expect(evidence.files.map((file) => file.name).sort()).toEqual(names);
      for (const file of evidence.files)
        expect(typeof file.deleteOpenSucceeded).toBe("boolean");
      expect(evidence.gitExists).toBe(false);
      expect(evidence.processQueryError).toBeUndefined();
      expect(evidence.filesQueryError).toBeUndefined();
    } finally {
      if (child.pid && child.exitCode === null) {
        child.kill();
        await once(child, "exit");
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);

if (process.platform === "win32") {
  test("cleanup diagnostic preserves holders and every Defender report field", () => {
    const root = diagnosticRoot();
    const host: CleanupReport["host"] = {
      holders: [{ pid: 717, name: "fixture holder", appType: 1 }],
      holderUnknown: false,
      defender: { RealTimeProtectionEnabled: true },
      defenderExclusions: [root],
      underDefenderExclusion: true,
      defenderError: "Defender state unavailable",
      exclusionError: "Defender exclusions unavailable",
    };
    const report = JSON.parse(
      cleanupReport(root, "EPERM", () => diagnosticResult(host)),
    ) as CleanupReport;
    expect(report.host).toEqual(host);
  });

  for (const hasPath of [true, false]) {
    test(`cleanup diagnostic wires the default spawn command and environment ${hasPath ? "with a failing path" : "with the root fallback"}`, () => {
      const root = diagnosticRoot();
      const path = hasPath ? join(root, "failing file.txt") : undefined;
      let invocation: Parameters<DiagnosticRunner> | undefined;
      cleanupReport(
        root,
        "EBUSY",
        (...args) => {
          invocation = args;
          return diagnosticResult({ holders: [], holderUnknown: true });
        },
        path,
      );
      expect(invocation).toBeDefined();
      const [command, args, options] = invocation!;
      expect(command).toBe("powershell.exe");
      expect(args).toEqual([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        cleanupDiagnosticCommand,
      ]);
      expect(options.encoding).toBe("utf8");
      expect(options.windowsHide).toBe(true);
      expect(options.env?.FORGE_LANE_CLOSE_DIAGNOSTIC_ROOT).toBe(root);
      expect(options.env?.FORGE_LANE_CLOSE_DIAGNOSTIC_PATH).toBe(path ?? root);
    });
  }

  test("cleanup diagnostic records matching processes and bin delete-access probes", () => {
    const root = diagnosticRoot();
    const evidence: CleanupEvidence = {
      processes: [
        {
          ProcessId: 813,
          ParentProcessId: 717,
          Name: "git.exe",
          ExecutablePath: join(root, "bin", "git.exe"),
          CommandLine: "x".repeat(300),
          CreationDate: "2026-11-04T00:00:00.0000000Z",
        },
      ],
      files: [
        { name: "git.exe", deleteOpenSucceeded: false },
        { name: "gh", deleteOpenSucceeded: true },
      ],
      gitExists: true,
    };
    let queried = false;
    const report = JSON.parse(
      cleanupReport(root, "EPERM", (command, args, options) => {
        if (args[3] !== cleanupEvidenceCommand)
          return diagnosticResult({ holders: [], holderUnknown: true });
        queried = true;
        expect(command).toBe("powershell.exe");
        expect(args.slice(0, 3)).toEqual([
          "-NoProfile",
          "-NonInteractive",
          "-Command",
        ]);
        expect(options.timeout).toBe(10_000);
        expect(options.windowsHide).toBe(true);
        expect(options.encoding).toBe("utf8");
        expect(options.env?.FORGE_LANE_CLOSE_DIAGNOSTIC_ROOT).toBe(root);
        for (const fragment of [
          "Get-CimInstance Win32_Process -ErrorAction Stop",
          "-Filter $filter",
          "$_.ExecutablePath.IndexOf($root, [StringComparison]::OrdinalIgnoreCase)",
          "$_.CommandLine.IndexOf($root, [StringComparison]::OrdinalIgnoreCase)",
          "$_.CommandLine.Substring(0, [Math]::Min(300, $_.CommandLine.Length))",
          "catch { $data.processQueryError = 'Win32_Process query failed' }",
          "Get-ChildItem -LiteralPath $bin -Force -ErrorAction Stop",
        ])
          expect(args[3]).toContain(fragment);
        for (const fragment of [
          "CreateFileW(path, 0x00010000, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)",
          "using (SafeFileHandle handle",
        ])
          expect(cleanupNativeSource).toContain(fragment);
        return { status: 0, stdout: JSON.stringify(evidence) };
      }),
    ) as CleanupReport;
    expect(queried).toBe(true);
    expect(report.processes).toEqual(evidence.processes);
    expect(report.files).toEqual(evidence.files);
    expect(report.gitExists).toBe(true);
    expect(report.processQueryError).toBeUndefined();
  });

  test("cleanup diagnostic preserves bin evidence when the process query fails", () => {
    const root = diagnosticRoot();
    const report = JSON.parse(
      cleanupReport(root, "EBUSY", (_command, args) => {
        if (args[3] !== cleanupEvidenceCommand)
          return diagnosticResult({ holders: [], holderUnknown: true });
        return {
          status: 0,
          stdout: JSON.stringify({
            processes: [],
            processQueryError: "Win32_Process query failed",
            files: [{ name: "gh", deleteOpenSucceeded: true }],
            gitExists: false,
          }),
        };
      }),
    ) as CleanupReport;
    expect(report.processes).toEqual([]);
    expect(report.processQueryError).toBe("Win32_Process query failed");
    expect(report.files).toEqual([{ name: "gh", deleteOpenSucceeded: true }]);
    expect(report.gitExists).toBe(false);
    expect(report.host).toEqual({ holders: [], holderUnknown: true });
  });

  test("cleanup diagnostic preserves process evidence when the bin query fails", () => {
    const root = diagnosticRoot();
    const processes: CleanupEvidence["processes"] = [
      {
        ProcessId: 813,
        ParentProcessId: 717,
        Name: "git.exe",
        ExecutablePath: join(root, "bin", "git.exe"),
        CommandLine: "git status",
        CreationDate: "2026-11-04T00:00:00.0000000Z",
      },
    ];
    const report = JSON.parse(
      cleanupReport(root, "EBUSY", (_command, args) => {
        if (args[3] !== cleanupEvidenceCommand)
          return diagnosticResult({ holders: [], holderUnknown: true });
        return {
          status: 0,
          stdout: JSON.stringify({
            processes,
            filesQueryError: "Bin delete-access query failed",
            files: [],
            gitExists: null,
          }),
        };
      }),
    ) as CleanupReport;
    expect(report.processes).toEqual(processes);
    expect(report.filesQueryError).toBe("Bin delete-access query failed");
    expect(report.processQueryError).toBeUndefined();
    expect(report.files).toEqual([]);
    expect(report.gitExists).toBeNull();
    expect(report.host).toEqual({ holders: [], holderUnknown: true });
  }, 10_000);

  for (const failure of [
    "exit",
    "timeout",
    "malformed JSON",
    "exception",
  ] as const) {
    test(`cleanup diagnostic records evidence-query ${failure} without replacing the cleanup error`, () => {
      const root = diagnosticRoot();
      const report = JSON.parse(
        cleanupReport(root, "EBUSY", (_command, args) => {
          if (args[3] !== cleanupEvidenceCommand)
            return diagnosticResult({ holders: [], holderUnknown: true });
          if (failure === "exception")
            throw new Error("injected query exception");
          if (failure === "timeout")
            return {
              status: null,
              stdout: "",
              error: new Error("injected timeout"),
            };
          return { status: failure === "exit" ? 1 : 0, stdout: "{" };
        }),
      ) as CleanupReport;
      expect(report.processQueryError).toBe(
        "Cleanup evidence query did not complete",
      );
      expect(report.filesQueryError).toBe(
        "Cleanup evidence query did not complete",
      );
      expect(report.processes).toEqual([]);
      expect(report.files).toEqual([]);
      expect(report.gitExists).toBeNull();
      expect(report.host).toEqual({ holders: [], holderUnknown: true });
    });
  }

  test("cleanup diagnostic never reports diagnostic stderr", () => {
    const root = diagnosticRoot();
    const marker = "SECRET-MARKER-717";
    let called = false;
    const report = cleanupReport(root, "EBUSY", (command, args, options) => {
      called = true;
      expect(command).toBe("powershell.exe");
      expect(args.slice(0, 3)).toEqual([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
      ]);
      const script = args[3]!;
      if (script === cleanupEvidenceCommand)
        return {
          status: 0,
          stdout: JSON.stringify({
            processes: [],
            files: [],
            gitExists: false,
          }),
          stderr: marker,
        };
      expect(script).toContain(
        "@{ pid = $_.process.pid; name = $_.name; appType = $_.appType }",
      );
      expect(
        /commandline|executablepath|parentprocessid|Get-CimInstance|Get-WmiObject/i.test(
          script,
        ),
      ).toBe(false);
      expect(options.env?.FORGE_LANE_CLOSE_DIAGNOSTIC_ROOT).toBe(root);
      expect(options.env?.FORGE_LANE_CLOSE_DIAGNOSTIC_PATH).toBe(root);
      return {
        ...diagnosticResult({
          holders: [{ pid: 717, name: "fixture holder", appType: 1 }],
          holderUnknown: false,
        }),
        stderr: marker,
      };
    });
    expect(called).toBe(true);
    expect((JSON.parse(report) as CleanupReport).host).toEqual({
      holders: [{ pid: 717, name: "fixture holder", appType: 1 }],
      holderUnknown: false,
    });
    expect(report.includes(marker)).toBe(false);
    expect(/systemstderr/i.test(report)).toBe(false);
  });

  test("cleanup diagnostic reports the holder returned by the runner", () => {
    const root = diagnosticRoot();
    const path = join(root, "held.txt");
    writeFileSync(path, "held fixture");
    const pid = 717;
    const host = {
      holders: [{ pid, name: "fixture holder", appType: 1 }],
      holderUnknown: false,
    };
    let called = false;
    const report = JSON.parse(
      cleanupReport(
        root,
        "EBUSY",
        (_command, _args, options) => {
          called = true;
          expect(options.env?.FORGE_LANE_CLOSE_DIAGNOSTIC_PATH).toBe(path);
          return diagnosticResult(host);
        },
        path,
      ),
    ) as CleanupReport;
    expect(called).toBe(true);
    expect(report.host.holders.some((holder) => holder.pid === pid)).toBe(true);
    expect(report.host.holderUnknown).toBe(false);
    for (const holder of report.host.holders) {
      expect(Object.keys(holder).sort()).toEqual(["appType", "name", "pid"]);
      expect(typeof holder.name).toBe("string");
      expect(typeof holder.appType).toBe("number");
    }
  });

  test("cleanup diagnostic handles EPERM and rethrows the original error", () => {
    const root = diagnosticRoot();
    const report = JSON.parse(
      cleanupReport(root, "EPERM", () =>
        diagnosticResult({
          holders: [],
          holderUnknown: true,
          holderReason: "Restart Manager query failed",
        }),
      ),
    ) as CleanupReport;
    expect(report.root).toBe(root);
    expect(report.host.holders).toEqual([]);
    expect(report.host.holderUnknown).toBe(true);
    expect(report.host.holderReason).toBe("Restart Manager query failed");
  });

  test("cleanup diagnostic handles forced EBUSY and rethrows the original error", () => {
    const root = diagnosticRoot();
    const path = join(root, "unlocked.txt");
    writeFileSync(path, "unlocked fixture");
    const report = JSON.parse(
      cleanupReport(
        root,
        "EBUSY",
        () =>
          diagnosticResult({
            holders: [],
            holderUnknown: true,
            holderReason: "Restart Manager returned no holders",
          }),
        path,
      ),
    ) as CleanupReport;
    expect(report.root).toBe(root);
    expect(report.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(report.host.holders).toEqual([]);
    expect(report.host.holderUnknown).toBe(true);
    expect(report.host.holderReason).toBe(
      "Restart Manager returned no holders",
    );
  });

  for (const [name, run] of [
    [
      "timeout",
      () => ({
        status: null,
        stdout: "",
        error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
      }),
    ],
    [
      "nonzero exit",
      () => ({ status: 1, stdout: '{"holders":[{"pid":717}]}' }),
    ],
    ["malformed JSON", () => ({ status: 0, stdout: "not JSON" })],
    [
      "runner exception",
      () => {
        throw new Error("runner failed");
      },
    ],
  ] satisfies [string, DiagnosticRunner][]) {
    test(`cleanup diagnostic falls back on ${name} and rethrows the original error`, () => {
      const root = diagnosticRoot();
      let called = false;
      const report = JSON.parse(
        cleanupReport(root, "EBUSY", () => {
          called = true;
          return run();
        }),
      ) as CleanupReport;
      expect(called).toBe(true);
      expect(report.host).toEqual({
        holders: [],
        holderUnknown: true,
        holderReason: "PowerShell diagnostic did not complete",
      });
      if (name === "malformed JSON" || name === "runner exception")
        expect(report.diagnosticError).toBe("Cleanup diagnostic failed");
    });
  }

  test("cleanup diagnostic probes read-only files without reporting a write-access failure", () => {
    const root = diagnosticRoot();
    const path = join(root, "read-only.txt");
    writeFileSync(path, "read-only fixture");
    chmodSync(path, 0o444);
    try {
      const report = JSON.parse(
        cleanupReport(root, "EPERM", () =>
          diagnosticResult({ holders: [], holderUnknown: true }),
        ),
      ) as CleanupReport;
      expect(report.failures).toEqual([]);
    } finally {
      chmodSync(path, 0o666);
    }
  });

  test("cleanup diagnostic lists failed file probes", () => {
    const root = diagnosticRoot();
    const path = join(root, "missing-target");
    writeFileSync(path, "unreadable fixture");
    const open = spyOn(fs, "openSync").mockImplementation(() => {
      throw Object.assign(new Error("injected probe failure"), {
        code: "EACCES",
      });
    });
    try {
      const report = JSON.parse(
        cleanupReport(root, "EPERM", () =>
          diagnosticResult({ holders: [], holderUnknown: true }),
        ),
      ) as CleanupReport;
      expect(report.failures).toEqual([{ path, code: "EACCES" }]);
    } finally {
      open.mockRestore();
    }
  });

  test("cleanup diagnostic reports a scan failure and rethrows the original error", () => {
    const root = join(diagnosticRoot(), "absent");
    const report = JSON.parse(
      cleanupReport(root, "EPERM", () =>
        diagnosticResult({ holders: [], holderUnknown: true }),
      ),
    ) as CleanupReport;
    expect(report.scanError).toContain("ENOENT");
    expect(report.failures).toEqual([]);
  });

  test("cleanup diagnostic rethrows the original error even if logging fails", () => {
    const root = diagnosticRoot();
    const original = Object.assign(new Error("original cleanup failure"), {
      code: "EBUSY",
    });
    const log = spyOn(console, "error").mockImplementation(() => {
      throw new Error("logging failed");
    });
    try {
      let caught: unknown;
      try {
        diagnoseCleanup(root, Date.now(), original, () =>
          diagnosticResult({ holders: [], holderUnknown: true }),
        );
      } catch (error) {
        caught = error;
      }
      expect(caught === original).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  test("successful cleanup never runs the diagnostic", () => {
    const root = diagnosticRoot();
    let called = false;
    cleanupRoot(
      root,
      Date.now(),
      () => {},
      () => {
        called = true;
        throw new Error("unexpected diagnostic");
      },
    );
    expect(called).toBe(false);
  });
}

type Call = {
  command: string;
  args: string[];
  input?: Record<string, unknown>;
  laneLocked?: boolean;
  laneHead?: string;
  branchHead?: string;
};
type Receipt = {
  id: string;
  status: string;
  subject: string;
  checked: { name: string; status: string }[];
};
type State = {
  issue: { id: string; title: string; status: string; receipt?: string };
  pr: {
    state: string;
    headRefName: string;
    headRefOid: string;
    mergeCommit: { oid: string } | null;
    url: string;
  };
  receipt: Receipt | null;
  links: { relation: string; url: string }[];
  comments: string[];
  fail?: string;
  hideClosed?: boolean;
  commitOnComment?: boolean;
  ignoredOnComment?: boolean;
  runOnComment?: boolean;
  observeLock?: boolean;
  observeHead?: boolean;
};
function fixture(ignored: string[] = [], trace = false) {
  const root = realpathSync.native(
    mkdtempSync(join(tmpdir(), "forge-lane-close-")),
  );
  roots.push(root);
  const main = join(root, "main"),
    caller = join(root, "caller"),
    bin = join(root, "bin");
  // The trace test needs a fresh seed so the commits, push and fetch run under trace.
  const cached = trace
    ? undefined
    : repositories.restore(JSON.stringify(ignored), root);
  if (!cached) {
    mkdirSync(main);
    writeFileSync(join(main, "package.json"), '{"name":"lane-close-fixture"}');
    mkdirSync(join(main, ".forge"));
    writeFileSync(
      join(main, ".forge", "config.yaml"),
      "values:\n  lanes:\n    tiers: {security: [], code: []}\n    roles:\n      builder: {harness: codex, model: fixture, effort: high}\n",
    );
    writeFileSync(
      join(main, ".gitignore"),
      [".worktrees/", ...ignored, ""].join("\n"),
    );
  }
  mkdirSync(bin);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|HOME|USERPROFILE)$/i.test(
        key,
      ),
    ),
  );
  const pathKey =
    Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const realGit = Bun.which("git");
  if (!realGit) throw new Error("git executable not found");
  env[pathKey] = bin + delimiter + (env[pathKey] ?? "");
  const gitConfig = [
    ["maintenance.auto", "false"],
    ["gc.auto", "0"],
    ["gc.autoDetach", "false"],
    ["core.fsmonitor", "false"],
  ] as const;
  for (const [key, value] of gitConfig) {
    const index = Number(env.GIT_CONFIG_COUNT ?? "0");
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
    env.GIT_CONFIG_COUNT = String(index + 1);
  }
  // Local pushes strip GIT_CONFIG_COUNT before starting receive-pack.
  env.GIT_CONFIG_GLOBAL = join(root, "gitconfig");
  writeFileSync(
    env.GIT_CONFIG_GLOBAL,
    gitConfig
      .map(([key, value]) => {
        const [section, name] = key.split(".");
        return `[${section}]\n${name}=${value}\n`;
      })
      .join(""),
  );
  if (trace) env.GIT_TRACE2_EVENT = join(root, "git-trace.jsonl");
  env.FORGE_DEVICE_ROOT = join(root, "device");
  env.FORGE_GH_USER = "fixture-owner";
  env.LANE_CLOSE_FIXTURE = root;
  env.LANE_CLOSE_REAL_GIT = realGit;
  env.LANE_CLOSE_RUN_SCRIPT = script;
  env.LANE_CLOSE_CALLER = caller;
  const stateFile = join(root, "state.json");
  const callsFile = join(root, "calls.jsonl");
  const fake = join(root, "fake.mjs");
  writeFileSync(
    fake,
    String.raw`import {appendFileSync,existsSync,readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';import {spawnSync} from 'node:child_process';
const root=process.env.LANE_CLOSE_FIXTURE,[command,...args]=process.argv.slice(2),file=join(root,'state.json');
const state=JSON.parse(readFileSync(file,'utf8'));
const inputIndex=args.indexOf('--input');const input=inputIndex<0?undefined:JSON.parse(args[inputIndex+1]);
const head=ref=>spawnSync(process.env.LANE_CLOSE_REAL_GIT,['-C',join(root,'main','.worktrees','one'),'rev-parse',ref],{encoding:'utf8',windowsHide:true}).stdout.trim();
appendFileSync(join(root,'calls.jsonl'),JSON.stringify({command,args,...(input?{input}:{}),...(state.observeLock?{laneLocked:existsSync(join(root,'main','.git','forge-lane-one.lock'))}:{}),...(state.observeHead?{laneHead:head('HEAD'),branchHead:head('refs/heads/lane/one')}:{})})+'\n');
if(command==='codex'){const output=args.findIndex(arg=>arg==='--output-last-message'||arg==='-o');if(output<0)process.exit(97);readFileSync(0,'utf8');writeFileSync(args[output+1],'Fixture reply.\n');console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-session'}));process.exit(0)}
const save=()=>writeFileSync(file,JSON.stringify(state));
const ok=result=>console.log(JSON.stringify({ok:true,op:args.slice(0,2).join('.'),status:'OK',result,warnings:[]}));
const record=(value,index)=>({namespace:'work',key:'fixture:'+index,revision:1,value,updatedAt:'2026-10-29T00:00:00.000Z',updatedBy:{kind:'human',id:'fixture'}});
if(command==='gh'){
 if(args[0]==='auth'&&args[1]==='token'){console.log('synthetic-fixture-auth');process.exit(0)}
 if(args[0]!=='pr'||args[1]!=='view')process.exit(93);
 if(process.env.GH_TOKEN!=='synthetic-fixture-auth')process.exit(96);
 if(state.fail==='gh')process.exit(1);
 if(state.fail==='gh-json'){console.log('{');process.exit(0)}
 console.log(JSON.stringify(state.pr));process.exit(0);
}
const op=args.slice(0,2).join('.');
if(state.fail===op){console.log(JSON.stringify({ok:false,op,status:'FAIL',error:{code:'FIXTURE_REFUSED',message:'injected '+op+' failure'}}));process.exit(1)}
switch(op){
 case 'issue.show':ok({...state.issue,...(state.hideClosed?{status:'open'}:{}),id:input.id});break;
 case 'check.show':ok(state.receipt===null?null:{...state.receipt,version:1,checkedAt:'2026-10-29T00:00:00.000Z',reason:'All selected checks passed',inputsDigest:'sha256:fixture-inputs',digest:'sha256:fixture-receipt',runs:state.receipt.checked.map(check=>({...check,argv:['fixture-check'],executable:'fixture-check',testCount:1,exitCode:0,signal:null,timedOut:false,truncated:false,stdout:'',stderr:'',stdoutEvidence:null,stderrEvidence:null,durationMs:1,reason:'Command passed'}))});break;
 case 'issue.links':ok({records:state.links.map((value,index)=>record({id:input.id,...value},index))});break;
 case 'issue.comments':ok({records:state.comments.map((body,index)=>record({id:input.id,body},index))});break;
 case 'issue.claim':ok({subject:'issue:'+input.id,generation:1,expiresAt:'2099-01-01T00:00:00.000Z',holder:{actor:{kind:'human',id:'fixture'},session:{id:'fixture'}}});break;
 case 'issue.owns':ok({id:input.id,owned:true});break;
 case 'issue.link':state.links.push({relation:input.relation,url:input.url});save();ok(record(input,state.links.length));break;
 case 'issue.close':state.issue.status='closed';state.issue.receipt=input.receipt;save();ok(state.issue);break;
 case 'issue.comment':state.comments.push(input.body);save();if(state.ignoredOnComment)writeFileSync(join(root,'main','.worktrees','one','ignored-during-comment.txt'),'Local note created during landing comment.\n');if(state.runOnComment){const result=spawnSync(process.execPath,[process.env.LANE_CLOSE_RUN_SCRIPT,'run','one','--role','builder','--prompt',join(root,'brief.md')],{cwd:process.env.LANE_CLOSE_CALLER,env:process.env,encoding:'utf8',timeout:15000,windowsHide:true});writeFileSync(join(root,'concurrent-run.json'),JSON.stringify({code:result.status,stdout:result.stdout,stderr:result.stderr,error:result.error?.message}));}if(state.commitOnComment){const lane=join(root,'main','.worktrees','one');writeFileSync(join(lane,'change.txt'),'Clean new commit during close.\n');const result=spawnSync(process.env.LANE_CLOSE_REAL_GIT,['-C',lane,'-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-am','new commit during landing comment'],{env:process.env,encoding:'utf8',windowsHide:true});if(result.status!==0)process.exit(95)}ok({id:input.id,commentId:'comment:fixture:'+state.comments.length});break;
 default:console.error('Unexpected fake Forge operation: '+op);process.exit(94);
}`,
  );
  function shim(name: string, file: string, prefix = "") {
    const target = file.replaceAll("\\", "/");
    writeFileSync(
      join(bin, name),
      `#!/bin/sh\nexec "${process.execPath.replaceAll("\\", "/")}" "${target}" ${prefix} "$@"\n`,
    );
    chmodSync(join(bin, name), 0o755);
    if (process.platform === "win32")
      writeFileSync(
        join(bin, `${name}.cmd`),
        `@"${process.execPath}" "${file}" ${prefix} %*\r\n`,
      );
  }
  shim("forge", fake, "forge");
  shim("gh", fake, "gh");
  shim("codex", fake, "codex");
  const git = (args: string[], cwd = main) => {
    const result = spawnSync(realGit, args, {
      cwd,
      env,
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    });
    if (result.status !== 0)
      throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const commit = (message: string, cwd = main) =>
    git(
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "-m",
        message,
      ],
      cwd,
    );
  if (!cached) {
    git(["init", "--initial-branch=main"]);
    git(["add", "package.json", ".gitignore", ".forge/config.yaml"]);
    commit("fixture");
    git(["init", "--bare", "--initial-branch=main", join(root, "remote.git")]);
    git(["remote", "add", "origin", join(root, "remote.git")]);
    git(["push", "origin", "main"]);
    git(["fetch", "origin", "main"]);
    git(["worktree", "add", "--detach", caller, "origin/main"]);
  }
  const brief = join(root, "brief.md");
  writeFileSync(
    brief,
    [
      "Goal",
      "Acceptance test",
      "Files",
      "Forbidden actions",
      "Stop point",
      "Prior art",
    ]
      .map(
        (section) =>
          `## ${section}\nConcrete ${section.toLowerCase()} evidence.\n`,
      )
      .join("\n"),
  );
  writeFileSync(
    stateFile,
    JSON.stringify({ issue: { id: "one", title: "Fixture", status: "open" } }),
  );
  function run(args: string[], cwd = caller) {
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    return {
      code: result.status,
      output: JSON.parse(result.stdout) as Record<string, unknown>,
      stderr: result.stderr,
    };
  }
  const lane = join(main, ".worktrees", "one");
  let head = cached?.head ?? "",
    merge = cached?.merge ?? "";
  if (!cached) {
    const started = run([
      "start",
      "one",
      "--branch",
      "lane/one",
      "--brief",
      brief,
    ]);
    expect(started.code).toBe(0);
    expect(started.output.worktree).toBe(lane);
    writeFileSync(join(lane, "change.txt"), "Delivered change.\n");
    git(["add", "change.txt"], lane);
    commit("lane change", lane);
    head = git(["rev-parse", "lane/one"]);
    git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "merge",
      "--no-ff",
      "lane/one",
      "-m",
      "merge delivered lane",
    ]);
    merge = git(["rev-parse", "HEAD"]);
    git(["push", "origin", "main"]);
    git(["fetch", "origin", "main"]);
    if (!trace)
      repositories.save(JSON.stringify(ignored), root, { head, merge });
  }
  const state: State = {
    issue: { id: "one", title: "Fixture", status: "open" },
    pr: {
      state: "MERGED",
      headRefName: "lane/one",
      headRefOid: head,
      mergeCommit: { oid: merge },
      url: "https://github.com/fixture/repo/pull/42",
    },
    receipt: {
      id: "receipt-one",
      status: "PASS",
      subject: merge,
      checked: [
        { name: "unit", status: "PASS" },
        { name: "types", status: "PASS" },
      ],
    },
    links: [],
    comments: [],
  };
  writeFileSync(stateFile, JSON.stringify(state));
  writeFileSync(callsFile, "");
  const common = join(main, ".git");
  const registry = join(common, "forge-lanes.json");
  const history = join(common, "forge-lane-runs", "one", "previous-run");
  mkdirSync(history, { recursive: true });
  writeFileSync(join(history, "reply.md"), "Durable prior reply.\n");
  const record = JSON.stringify({
    role: "builder",
    round: null,
    model: "fixture",
    effort: "high",
    start: "2026-10-29T00:00:00.000Z",
    end: "2026-10-29T00:00:01.000Z",
    verdict: "completed",
    session: null,
    reply: join(history, "reply.md"),
  });
  writeFileSync(join(history, "run.json"), record);
  const readState = () => JSON.parse(readFileSync(stateFile, "utf8")) as State;
  function change(edit: (value: State) => void) {
    const value = readState();
    edit(value);
    writeFileSync(stateFile, JSON.stringify(value));
  }
  const calls = () =>
    readFileSync(callsFile, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Call);
  const writes = () =>
    calls().filter(
      (call) =>
        call.command === "forge" &&
        ["claim", "link", "close", "comment"].includes(call.args[1]!),
    );
  function cleanupFailure(kind: "worktree" | "branch") {
    env.LANE_CLOSE_CLEANUP_KIND = kind;
    const helper = join(root, "fake-git.mjs");
    writeFileSync(
      helper,
      `import {spawnSync} from 'node:child_process';import {existsSync} from 'node:fs';import {join} from 'node:path';const kind=process.env.LANE_CLOSE_CLEANUP_KIND,args=process.argv.slice(2).filter(Boolean);if(existsSync(join(process.env.LANE_CLOSE_FIXTURE,'fail-cleanup'))&&(args.includes(kind)||(kind==='branch'&&args.includes('update-ref')))&&args.some(a=>['remove','-d','-D'].includes(a))){console.error('injected cleanup failure');process.exit(1)}const result=spawnSync(process.env.LANE_CLOSE_REAL_GIT,args,{stdio:'inherit',env:process.env,windowsHide:true});process.exit(result.status??1);`,
    );
    if (process.platform === "win32" && !gitBin) {
      // Bun refuses Git's %(refname) batch argument; keep the mapped image outside test roots.
      gitBin = mkdtempSync(join(tmpdir(), "forge-lane-close-git-"));
      const compiled = spawnSync(
        process.execPath,
        ["build", helper, "--compile", "--outfile", join(gitBin, "git.exe")],
        {
          cwd: root,
          env,
          encoding: "utf8",
          timeout: 30_000,
          windowsHide: true,
        },
      );
      if (compiled.status !== 0)
        throw new Error(
          `fake git executable compilation failed: ${compiled.stderr}`,
        );
    } else if (process.platform !== "win32") shim("git", helper);
    if (gitBin) env[pathKey] = gitBin + delimiter + env[pathKey];
    writeFileSync(join(root, "fail-cleanup"), "");
  }
  const close = (extra: string[] = []) =>
    run(["close", "one", "--pr", "42", "--receipt", "receipt-one", ...extra]);
  const registered = () =>
    JSON.parse(readFileSync(registry, "utf8")) as { issue: string }[];
  const branchExists = () =>
    git(["for-each-ref", "--format=%(refname)", "refs/heads/lane/one"]) !== "";
  function retained() {
    expect(existsSync(lane)).toBe(true);
    expect(branchExists()).toBe(true);
    expect(registered().map((entry) => entry.issue)).toEqual(["one"]);
    const listed = run(["list"]);
    expect(listed.code).toBe(0);
    expect(listed.output.lanes).toHaveLength(1);
    expect(listed.output.lanes).toMatchObject([
      { issue: "one", worktree: lane, branch: "lane/one" },
    ]);
  }
  function cleaned() {
    expect(existsSync(lane)).toBe(false);
    expect(branchExists()).toBe(false);
    expect(registered()).toEqual([]);
    const listed = run(["list"]);
    expect(listed.code).toBe(0);
    expect(listed.output.lanes).toEqual([]);
    expect(git(["worktree", "list", "--porcelain"])).not.toContain(
      lane.replaceAll("\\", "/"),
    );
    expect(readFileSync(join(history, "run.json"), "utf8")).toBe(record);
    expect(readFileSync(join(history, "reply.md"), "utf8")).toBe(
      "Durable prior reply.\n",
    );
  }
  return {
    root,
    main,
    lane,
    common,
    registry,
    run,
    close,
    calls,
    writes,
    change,
    readState,
    git,
    commit,
    head,
    merge,
    retained,
    cleaned,
    cleanupFailure,
  };
}
function expectedComment(f: ReturnType<typeof fixture>) {
  return `PR #42 landed: https://github.com/fixture/repo/pull/42\nMerge commit: ${f.merge}\nReceipt: receipt-one\nChecks: unit: PASS, types: PASS`;
}

function released(f: ReturnType<typeof fixture>) {
  expect(
    readdirSync(f.common).filter((name) =>
      name.startsWith("forge-lane-one.lock"),
    ),
  ).toEqual([]);
  expect(existsSync(join(f.common, "forge-lanes.lock"))).toBe(false);
}

function updateBranch(f: ReturnType<typeof fixture>) {
  writeFileSync(join(f.main, "main.txt"), "New main work.\n");
  f.git(["add", "main.txt"]);
  f.commit("advance main");
  f.git(
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "merge",
      "--no-ff",
      "main",
      "-m",
      "update branch",
    ],
    f.lane,
  );
  const head = f.git(["rev-parse", "HEAD"], f.lane);
  f.git(["push", "origin", "lane/one", `${head}:refs/pull/42/head`]);
  f.git(["push", "origin", "--delete", "lane/one"]);
  f.git(["reset", "--hard", f.head], f.lane);
  f.change((state) => {
    state.pr.headRefOid = head;
    state.observeHead = true;
  });
  return head;
}

test("lane close fixture never starts automatic maintenance or gc", () => {
  const f = fixture([], true);
  expect(f.close().code).toBe(0);
  f.cleaned();
  const children = readFileSync(join(f.root, "git-trace.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { event: string; argv?: string[] })
    .filter((event) => event.event === "child_start");
  expect(children.length).toBeGreaterThan(0);
  const argv = children.map(({ argv }) => (argv ?? []).join(" "));
  expect(argv.some((line) => line.includes("receive-pack"))).toBe(true);
  expect(argv.some((line) => line.includes("fetch"))).toBe(true);
  expect(
    children.filter(
      ({ argv }) => argv?.includes("maintenance") && argv.includes("run"),
    ),
  ).toHaveLength(0);
  expect(
    children.filter(
      ({ argv }) => argv?.includes("gc") && argv.includes("--auto"),
    ),
  ).toHaveLength(0);
});

test("update-branch head closes in one call after the remote branch is deleted", () => {
  const f = fixture();
  const head = updateBranch(f);
  const result = f.close();
  expect(result.code).toBe(0);
  expect(f.calls().find((call) => call.args[1] === "comment")).toMatchObject({
    laneHead: head,
    branchHead: head,
  });
  f.cleaned();
});

test("update-branch cleanup resumes with the fast-forwarded journal head", () => {
  const f = fixture();
  const head = updateBranch(f);
  f.cleanupFailure("worktree");
  expect(f.close().output.code).toBe("CLEANUP_FAILED");
  expect(
    JSON.parse(
      readFileSync(join(f.common, "forge-lane-close-one.json"), "utf8"),
    ),
  ).toMatchObject({ head });
  rmSync(join(f.root, "fail-cleanup"));
  expect(f.close().code).toBe(0);
  f.cleaned();
});

for (const kind of ["diverged", "dirty", "fetched mismatch"] as const)
  test(`update-branch ${kind} refuses without moving the branch and names recovery commands`, () => {
    const f = fixture();
    const head = updateBranch(f);
    if (kind === "diverged") {
      writeFileSync(join(f.lane, "local.txt"), "Local work.\n");
      f.git(["add", "local.txt"], f.lane);
      f.commit("local divergence", f.lane);
    } else if (kind === "dirty") {
      writeFileSync(join(f.lane, "change.txt"), "Unsaved work.\n");
    } else {
      f.git(["push", "origin", ":refs/pull/42/head"]);
      f.git(["push", "origin", `${f.merge}:refs/pull/42/head`]);
    }
    const before = f.git(["rev-parse", "HEAD"], f.lane);
    const result = f.close();
    expect(result.code).toBe(1);
    expect(result.output.next).toContain("fetch origin pull/42/head");
    expect(result.output.next).toContain(`merge --ff-only ${head}`);
    expect(f.git(["rev-parse", "HEAD"], f.lane)).toBe(before);
    expect(f.git(["rev-parse", "lane/one"])).toBe(before);
    expect(f.writes()).toEqual([]);
    if (kind === "dirty")
      expect(readFileSync(join(f.lane, "change.txt"), "utf8")).toBe(
        "Unsaved work.\n",
      );
    f.retained();
  });

function dropped(f: ReturnType<typeof fixture>, extra: string[] = []) {
  return f.run([
    "close",
    "one",
    "--pr",
    "42",
    "--dropped",
    "measured slower",
    ...extra,
  ]);
}
function closedPR(f: ReturnType<typeof fixture>) {
  f.change((state) => {
    state.pr.state = "CLOSED";
    state.pr.mergeCommit = null;
    state.receipt = null;
  });
}

function closingRecords(f: ReturnType<typeof fixture>) {
  const history = join(f.common, "forge-lane-runs", "one");
  return readdirSync(history)
    .filter((name) => /^close(?:-.*)?\.json$/.test(name))
    .map(
      (name) =>
        JSON.parse(readFileSync(join(history, name), "utf8")) as Record<
          string,
          unknown
        >,
    );
}

test("two dropped closes for one issue retain both closing records", () => {
  const f = fixture();
  closedPR(f);
  expect(dropped(f).code).toBe(0);
  f.git(["worktree", "add", "filler", "lane/one"]);
  f.git(["worktree", "move", "filler", f.lane]);
  writeFileSync(
    f.registry,
    JSON.stringify([
      {
        issue: "one",
        branch: "lane/one",
        worktree: f.lane,
        brief: join(f.root, "brief.md"),
      },
    ]),
  );
  f.change((state) => {
    state.pr.url = "https://github.com/fixture/repo/pull/43";
  });
  expect(
    f.run(["close", "one", "--pr", "43", "--dropped", "second reason"]).code,
  ).toBe(0);
  expect(closingRecords(f)).toHaveLength(2);
  expect(
    closingRecords(f)
      .map(({ pr, dropped }) => ({ pr, dropped }))
      .sort((a, b) => Number(a.pr) - Number(b.pr)),
  ).toEqual([
    { pr: 42, dropped: "measured slower" },
    { pr: 43, dropped: "second reason" },
  ]);
});

test("dropped and receipt are refused before external calls", () => {
  const f = fixture();
  const result = f.run(
    [
      "close",
      "one",
      "--pr",
      "42",
      "--dropped",
      "reason",
      "--receipt",
      "unvalidated",
    ],
    f.root,
  );
  expect(result.code).toBe(2);
  expect(result.output.reasons).toEqual([
    "--dropped cannot be combined with --receipt",
  ]);
  expect(JSON.stringify(result.output)).not.toContain("unvalidated");
  expect(result.stderr).toBe("");
  expect(f.calls()).toEqual([]);
});

for (const pr of [[], ["--pr", "invalid"], ["--pr", "9007199254740992"]])
  test(`dropped requires only numeric PR: ${pr.join(" ") || "missing"}`, () => {
    const f = fixture();
    const result = f.run(["close", "one", ...pr, "--dropped", "reason"]);
    expect(result.code).toBe(2);
    expect(result.output.reasons).toEqual([
      "close --dropped requires numeric --pr",
    ]);
    expect(f.calls()).toEqual([]);
  });

test("head mismatch recovery commands preserve shell characters in the worktree path", () => {
  const f = fixture();
  const head = updateBranch(f);
  const lane = join(f.main, ".worktrees", "one $draft `tick's");
  f.git(["worktree", "move", f.lane, lane]);
  const entries = JSON.parse(readFileSync(f.registry, "utf8")) as {
    worktree: string;
  }[];
  entries[0]!.worktree = lane;
  writeFileSync(f.registry, JSON.stringify(entries));
  writeFileSync(join(lane, "change.txt"), "Preserve this work.\n");
  const result = f.close();
  expect(result.code).toBe(1);
  const commands = String(result.output.next).match(
    /git -C .*?; git -C .*?(?=; rerun close)/,
  )?.[0];
  expect(commands).toBeDefined();
  const executed = spawnSync("bash", ["-c", commands!], {
    cwd: f.root,
    env: { ...process.env, draft: "WRONG_DIRECTORY" },
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
  expect(executed.error).toBeUndefined();
  expect(executed.status).toBe(0);
  expect(f.git(["rev-parse", "HEAD"], lane)).toBe(head);
  expect(readFileSync(join(lane, "change.txt"), "utf8")).toBe(
    "Preserve this work.\n",
  );
});

test("dropped CLOSED lane needs no receipt, preserves local and remote branches and records why", () => {
  const f = fixture();
  closedPR(f);
  f.git(["push", "origin", "lane/one"]);
  expect(dropped(f).code).toBe(0);
  expect(f.git(["rev-parse", "lane/one"])).toBe(f.head);
  expect(f.git(["ls-remote", "origin", "refs/heads/lane/one"])).toContain(
    f.head,
  );
  expect(existsSync(f.lane)).toBe(false);
  expect(f.run(["list"]).output.lanes).toEqual([]);
  expect(f.readState().issue.status).toBe("open");
  expect(f.writes().map((call) => call.args[1])).toEqual(["comment"]);
  expect(closingRecords(f)[0]).toMatchObject({
    dropped: "measured slower",
    pr: 42,
    head: f.head,
  });
});

for (const kind of ["MERGED", "OPEN", "dirty"] as const)
  test(`dropped refuses ${kind} without tracker writes`, () => {
    const f = fixture();
    if (kind !== "MERGED") closedPR(f);
    if (kind === "OPEN")
      f.change((state) => {
        state.pr.state = kind;
      });
    if (kind === "dirty")
      writeFileSync(join(f.lane, "change.txt"), "Unsaved.\n");
    const result = dropped(f);
    expect(result.code).toBe(1);
    expect(result.output.reasons).toEqual([
      kind === "dirty"
        ? "lane worktree has uncommitted or untracked changes"
        : "--dropped requires a CLOSED, unmerged PR",
    ]);
    expect(f.writes()).toEqual([]);
    f.retained();
  });

test("dropped honours ignored-file consent and retries cleanup without duplicate comments", () => {
  const f = fixture(["ignored-note.txt"]);
  closedPR(f);
  writeFileSync(join(f.lane, "ignored-note.txt"), "Local notes.\n");
  expect(dropped(f).output.next).toContain("--discard-ignored");
  expect(f.writes()).toEqual([]);
  f.cleanupFailure("worktree");
  expect(dropped(f, ["--discard-ignored"]).output.code).toBe("CLEANUP_FAILED");
  rmSync(join(f.root, "fail-cleanup"));
  expect(dropped(f, ["--discard-ignored"]).output).toMatchObject({
    ok: true,
    discarded: ["ignored-note.txt"],
  });
  expect(f.writes().map((call) => call.args[1])).toEqual(["comment"]);
  expect(f.git(["rev-parse", "lane/one"])).toBe(f.head);
});

test("close serialization: a live run owner refuses close before external calls and preserves its lock", () => {
  const f = fixture();
  const lock = join(f.common, "forge-lane-one.lock");
  const owner = `owner-${process.pid}-${randomUUID()}`;
  mkdirSync(lock);
  writeFileSync(join(lock, owner), "Existing run owner.\n");
  const registry = readFileSync(f.registry, "utf8");
  const state = f.readState();
  const result = f.close();
  expect(result.code).toBe(1);
  expect(result.output).toMatchObject({
    ok: false,
    verdict: "refused",
    removed: false,
    next: "a lane run is active; wait for it to finish and retry close",
  });
  expect(f.calls()).toEqual([]);
  expect(readFileSync(f.registry, "utf8")).toBe(registry);
  expect(f.readState()).toEqual(state);
  expect(f.git(["rev-parse", "refs/heads/lane/one"])).toBe(f.head);
  expect(readFileSync(join(f.lane, "change.txt"), "utf8")).toBe(
    "Delivered change.\n",
  );
  expect(existsSync(join(f.common, "forge-lane-close-one.json"))).toBe(false);
  expect(readdirSync(lock)).toEqual([owner]);
  expect(readFileSync(join(lock, owner), "utf8")).toBe("Existing run owner.\n");
  expect(existsSync(join(f.common, "forge-lanes.lock"))).toBe(false);
  f.retained();
});

test("close serialization: a dead run owner is reclaimed and close releases the lane lock", () => {
  const f = fixture();
  const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  expect(dead.status).toBe(0);
  expect(() => process.kill(dead.pid, 0)).toThrow();
  const lock = join(f.common, "forge-lane-one.lock");
  mkdirSync(lock);
  writeFileSync(join(lock, `owner-${dead.pid}-${randomUUID()}`), "");
  expect(f.close().code).toBe(0);
  f.cleaned();
  released(f);
});

test("close serialization: a run started during the landing comment refuses without launching Codex", () => {
  const f = fixture();
  f.change((state) => {
    state.runOnComment = true;
    state.observeLock = true;
  });
  const result = f.close();
  const concurrent = JSON.parse(
    readFileSync(join(f.root, "concurrent-run.json"), "utf8"),
  ) as { code: number; stdout: string; stderr: string; error?: string };
  expect(concurrent.error).toBeUndefined();
  expect(concurrent.code).toBe(1);
  expect(JSON.parse(concurrent.stdout)).toMatchObject({
    verdict: "refused",
    next: "lane already running; wait for it to finish and retry",
  });
  expect(f.calls().filter((call) => call.command === "codex")).toEqual([]);
  expect(readdirSync(join(f.common, "forge-lane-runs", "one"))).toEqual([
    "previous-run",
  ]);
  expect(result.code).toBe(0);
  expect(f.calls().every((call) => call.laneLocked === true)).toBe(true);
  f.cleaned();
  released(f);
});

for (const failure of ["gh", "issue.close", undefined])
  test(`close serialization: lane lock spans external calls and releases after ${failure ?? "success"}`, () => {
    const f = fixture();
    f.change((state) => {
      state.observeLock = true;
      if (failure) state.fail = failure;
    });
    const result = f.close();
    expect(result.code).toBe(failure ? 1 : 0);
    expect(f.calls().length).toBeGreaterThan(0);
    expect(f.calls().every((call) => call.laneLocked === true)).toBe(true);
    released(f);
    if (failure) f.retained();
    else f.cleaned();
  });

test("close serialization: an ignored note created during the landing comment preserves cleanup and resumes once moved", () => {
  const f = fixture(["ignored*.txt"]);
  f.change((state) => {
    state.ignoredOnComment = true;
  });
  const registry = readFileSync(f.registry, "utf8");
  const result = f.close();
  expect(result.code).toBe(1);
  expect(result.output).toMatchObject({
    ok: false,
    code: "CLEANUP_FAILED",
    status: "closed",
    removed: false,
    next: "move what you need, then rerun close with --discard-ignored",
  });
  expect((result.output.reasons as string[]).join("\n")).toContain(
    "ignored-during-comment.txt",
  );
  expect(readFileSync(join(f.lane, "ignored-during-comment.txt"), "utf8")).toBe(
    "Local note created during landing comment.\n",
  );
  expect(readFileSync(f.registry, "utf8")).toBe(registry);
  expect(f.readState().issue.status).toBe("closed");
  expect(f.readState().comments).toEqual([expectedComment(f)]);
  const journal = join(f.common, "forge-lane-close-one.json");
  expect(JSON.parse(readFileSync(journal, "utf8"))).toMatchObject({
    pr: 42,
    receipt: "receipt-one",
    head: f.head,
    worktree: f.lane,
  });
  f.retained();
  released(f);
  rmSync(join(f.lane, "ignored-during-comment.txt"));
  expect(f.close().code).toBe(0);
  expect(f.writes().filter((call) => call.args[1] === "close")).toHaveLength(1);
  expect(f.writes().filter((call) => call.args[1] === "comment")).toHaveLength(
    1,
  );
  expect(existsSync(journal)).toBe(false);
  f.cleaned();
  released(f);
});

test("close serialization: discard consent covers and reports an ignored note created during the landing comment", () => {
  const f = fixture(["ignored*.txt"]);
  f.change((state) => {
    state.ignoredOnComment = true;
  });
  const result = f.close(["--discard-ignored"]);
  expect(result.code).toBe(0);
  expect(result.output).toMatchObject({
    ok: true,
    discarded: ["ignored-during-comment.txt"],
  });
  expect(f.readState().issue.status).toBe("closed");
  expect(f.readState().comments).toEqual([expectedComment(f)]);
  f.cleaned();
  released(f);
});

test("close claims, links, closes with the merge receipt, verifies and comments before removing the lane", () => {
  const f = fixture();
  const result = f.close();
  expect(result.code).toBe(0);
  expect(result.output).toMatchObject({
    ok: true,
    issue: "one",
    pr: 42,
    mergeCommit: f.merge,
    receipt: "receipt-one",
    status: "closed",
    removed: true,
  });
  expect(f.writes().map((call) => call.args[1])).toEqual([
    "claim",
    "link",
    "close",
    "comment",
  ]);
  expect(f.writes().find((call) => call.args[1] === "link")?.input).toEqual({
    id: "one",
    relation: "delivers",
    url: "https://github.com/fixture/repo/pull/42",
  });
  expect(f.writes().find((call) => call.args[1] === "close")?.input).toEqual({
    id: "one",
    receipt: "receipt-one",
    reason: `PR #42 merged as ${f.merge.slice(0, 7)}`,
  });
  expect(f.readState().issue).toMatchObject({
    status: "closed",
    receipt: "receipt-one",
  });
  expect(f.readState().comments).toEqual([expectedComment(f)]);
  const auth = f
    .calls()
    .find((call) => call.command === "gh" && call.args[0] === "auth");
  expect(auth?.args).toEqual(["auth", "token", "--user", "fixture-owner"]);
  const operations = f
    .calls()
    .filter((call) => call.command === "forge")
    .map((call) => call.args.slice(0, 2).join("."));
  const closing = operations.indexOf("issue.close");
  expect(
    operations.slice(closing + 1, operations.indexOf("issue.comment")),
  ).toContain("issue.show");
  const pr = f
    .calls()
    .find((call) => call.command === "gh" && call.args[0] === "pr");
  expect(pr?.args).toContain("42");
  expect(pr?.args[pr.args.indexOf("--json") + 1]?.split(",").sort()).toEqual(
    ["state", "headRefName", "headRefOid", "mergeCommit", "url"].sort(),
  );
  f.cleaned();
});

test("close --keep-open comments and removes the lane while leaving the issue open", () => {
  const f = fixture();
  const result = f.close(["--keep-open"]);
  expect(result.code).toBe(0);
  expect(result.output).toMatchObject({
    ok: true,
    issue: "one",
    pr: 42,
    mergeCommit: f.merge,
    receipt: "receipt-one",
    status: "open",
    removed: true,
  });
  expect(f.writes().map((call) => call.args[1])).toEqual(["comment"]);
  expect(f.readState().issue.status).toBe("open");
  expect(f.readState().comments).toEqual([expectedComment(f)]);
  f.cleaned();
});

const ignoredFiles = ["ignored-note.txt", "ignored note with spaces.txt"];
for (const file of ignoredFiles) {
  test(`ignored-file safety: close refuses ${JSON.stringify(file)} before Forge writes`, () => {
    const f = fixture(["ignored*.txt"]);
    const content = "Local notes that must survive a refused close.\n";
    writeFileSync(join(f.lane, file), content);
    const registry = readFileSync(f.registry, "utf8");
    const state = f.readState();
    const result = f.close();
    expect(result.code).toBe(1);
    expect(result.output.verdict).toBe("refused");
    expect((result.output.reasons as string[]).join("\n")).toContain(file);
    expect(result.output.next).toBe(
      "move what you need, then rerun close with --discard-ignored",
    );
    expect(f.writes()).toEqual([]);
    expect(readFileSync(join(f.lane, file), "utf8")).toBe(content);
    expect(readFileSync(f.registry, "utf8")).toBe(registry);
    expect(f.readState()).toEqual(state);
    f.retained();
  });

  test(`ignored-file safety: close --discard-ignored reports ${JSON.stringify(file)} and removes the lane`, () => {
    const f = fixture(["ignored*.txt"]);
    writeFileSync(join(f.lane, file), "Explicitly discarded local notes.\n");
    const result = f.close(["--discard-ignored"]);
    expect(result.code).toBe(0);
    expect(result.output).toMatchObject({ ok: true, discarded: [file] });
    expect(f.readState().issue.status).toBe("closed");
    expect(f.readState().comments).toEqual([expectedComment(f)]);
    f.cleaned();
  });
}

test("ignored-file safety: close refuses an ignored note when git config hides untracked files", () => {
  const f = fixture(["ignored-note.txt"]);
  f.git(["config", "status.showUntrackedFiles", "no"]);
  const content = "Local notes that must survive a hiding git config.\n";
  writeFileSync(join(f.lane, "ignored-note.txt"), content);
  const result = f.close();
  expect(result.code).toBe(1);
  expect((result.output.reasons as string[]).join("\n")).toContain(
    "ignored-note.txt",
  );
  expect(f.writes()).toEqual([]);
  expect(readFileSync(join(f.lane, "ignored-note.txt"), "utf8")).toBe(content);
  f.retained();
});

for (const directory of ["node_modules", "dist"])
  test(`ignored-file safety: close permits recreateable ${directory} without discard consent`, () => {
    const f = fixture([`${directory}/`]);
    mkdirSync(join(f.lane, directory));
    writeFileSync(join(f.lane, directory, "artifact.txt"), "Recreateable.\n");
    const result = f.close();
    expect(result.code).toBe(0);
    expect(result.output).toMatchObject({ ok: true, discarded: [] });
    expect(f.readState().issue.status).toBe("closed");
    f.cleaned();
  });

test("ignored-file safety: cleanup retry preserves discard consent and reports the discarded paths", () => {
  const f = fixture(["ignored-note.txt"]);
  writeFileSync(join(f.lane, "ignored-note.txt"), "Approved discard.\n");
  f.cleanupFailure("worktree");
  expect(f.close(["--discard-ignored"]).code).toBe(1);
  expect(f.readState().issue.status).toBe("closed");
  expect(f.readState().comments).toEqual([expectedComment(f)]);
  const writes = f.writes();
  const registry = readFileSync(f.registry, "utf8");
  rmSync(join(f.root, "fail-cleanup"));
  const refused = f.close();
  expect(refused.code).toBe(1);
  expect(refused.output.verdict).toBe("refused");
  expect(f.writes()).toEqual(writes);
  expect(readFileSync(f.registry, "utf8")).toBe(registry);
  expect(readFileSync(join(f.lane, "ignored-note.txt"), "utf8")).toBe(
    "Approved discard.\n",
  );
  f.retained();
  const result = f.close(["--discard-ignored"]);
  expect(result.code).toBe(0);
  expect(result.output.discarded).toEqual(["ignored-note.txt"]);
  expect(f.writes().filter((call) => call.args[1] === "close")).toHaveLength(1);
  expect(f.writes().filter((call) => call.args[1] === "comment")).toHaveLength(
    1,
  );
  f.cleaned();
});

const refusals: {
  name: string;
  edit: (f: ReturnType<typeof fixture>) => void;
}[] = [
  {
    name: "unmerged open PR",
    edit: (f) =>
      f.change((s) => {
        s.pr.state = "OPEN";
      }),
  },
  {
    name: "closed unmerged PR",
    edit: (f) =>
      f.change((s) => {
        s.pr.state = "CLOSED";
        s.pr.mergeCommit = null;
      }),
  },
  {
    name: "missing merge commit",
    edit: (f) =>
      f.change((s) => {
        s.pr.mergeCommit = null;
      }),
  },
  {
    name: "invalid merge SHA",
    edit: (f) =>
      f.change((s) => {
        s.pr.mergeCommit = { oid: "not-a-sha" };
      }),
  },
  {
    name: "different PR branch",
    edit: (f) =>
      f.change((s) => {
        s.pr.headRefName = "another-lane";
      }),
  },
  {
    name: "different PR head",
    edit: (f) =>
      f.change((s) => {
        s.pr.headRefOid = "a".repeat(40);
      }),
  },
  {
    name: "malformed PR head",
    edit: (f) =>
      f.change((s) => {
        s.pr.headRefOid = "invalid";
      }),
  },
  {
    name: "invalid PR URL",
    edit: (f) =>
      f.change((s) => {
        s.pr.url = "not-a-url";
      }),
  },
  {
    name: "unavailable GitHub",
    edit: (f) =>
      f.change((s) => {
        s.fail = "gh";
      }),
  },
  {
    name: "malformed GitHub JSON",
    edit: (f) =>
      f.change((s) => {
        s.fail = "gh-json";
      }),
  },
  {
    name: "missing receipt",
    edit: (f) =>
      f.change((s) => {
        s.receipt = null;
      }),
  },
  ...["FAIL", "INCOMPLETE", "NOT_EXECUTED"].map((status) => ({
    name: `${status} receipt`,
    edit: (f: ReturnType<typeof fixture>) =>
      f.change((s) => {
        s.receipt!.status = status;
      }),
  })),
  {
    name: "receipt for PR head instead of merge",
    edit: (f) =>
      f.change((s) => {
        s.receipt!.subject = f.head;
      }),
  },
  {
    name: "receipt for different merge",
    edit: (f) =>
      f.change((s) => {
        s.receipt!.subject = "b".repeat(40);
      }),
  },
  {
    name: "wrong receipt id",
    edit: (f) =>
      f.change((s) => {
        s.receipt!.id = "receipt-other";
      }),
  },
  {
    name: "tracked modifications",
    edit: (f) =>
      writeFileSync(join(f.lane, "change.txt"), "Dirty tracked content.\n"),
  },
  {
    name: "untracked file",
    edit: (f) =>
      writeFileSync(join(f.lane, "untracked.txt"), "Untracked content.\n"),
  },
  {
    name: "staged change",
    edit: (f) => {
      writeFileSync(join(f.lane, "change.txt"), "Staged content.\n");
      f.git(["add", "change.txt"], f.lane);
    },
  },
  {
    name: "missing lane worktree without a pending cleanup",
    edit: (f) => {
      f.git(["worktree", "remove", f.lane]);
    },
  },
];
for (const { name, edit } of refusals)
  test(`close refuses ${name} before Forge writes`, () => {
    const f = fixture();
    edit(f);
    const before = readFileSync(f.registry, "utf8");
    const result = f.close();
    expect(result.code).toBe(1);
    expect(result.output.verdict).toBe("refused");
    expect(f.writes()).toEqual([]);
    expect(readFileSync(f.registry, "utf8")).toBe(before);
    expect(f.readState().comments).toEqual([]);
  });

test("close refuses an unknown lane before GitHub or Forge writes", () => {
  const f = fixture();
  const result = f.run([
    "close",
    "unknown",
    "--pr",
    "42",
    "--receipt",
    "receipt-one",
  ]);
  expect(result.code).toBe(1);
  expect(result.output.verdict).toBe("refused");
  expect(f.calls()).toEqual([]);
  f.retained();
});

test("close rejects missing, duplicate, unknown and malformed flags before external reads", () => {
  const f = fixture();
  for (const args of [
    ["close"],
    ["close", "..", "--pr", "42", "--receipt", "receipt-one"],
    ["close", "one", "--receipt", "receipt-one"],
    ["close", "one", "--pr", "42"],
    ["close", "one", "--pr", "42", "--receipt"],
    ["close", "one", "--pr", "42", "--receipt", "receipt-one", "--unknown"],
    ["close", "one", "--pr", "42", "--receipt", "receipt-one", "--pr", "42"],
    [
      "close",
      "one",
      "--pr",
      "42",
      "--receipt",
      "receipt-one",
      "--receipt",
      "receipt-one",
    ],
    [
      "close",
      "one",
      "--pr",
      "42",
      "--receipt",
      "receipt-one",
      "--keep-open",
      "--keep-open",
    ],
    ...["0", "-1", "1.5", "NaN", "9007199254740992"].map((number) => [
      "close",
      "one",
      "--pr",
      number,
      "--receipt",
      "receipt-one",
    ]),
  ]) {
    const result = f.run(args);
    expect(result.code).toBe(2);
    expect(result.output.ok).toBe(false);
    expect(result.output.verdict).toBe("refused");
  }
  expect(f.calls()).toEqual([]);
  f.retained();
});

test("Forge close failure leaves the worktree, branch and registry available for recovery", () => {
  const f = fixture();
  f.change((s) => {
    s.fail = "issue.close";
  });
  expect(f.close().code).toBe(1);
  expect(f.writes().some((call) => call.args[1] === "close")).toBe(true);
  expect(f.readState().issue.status).toBe("open");
  expect(f.readState().comments).toEqual([]);
  f.retained();
});

test("failed close readback preserves the lane and does not publish a landing comment", () => {
  const f = fixture();
  f.change((s) => {
    s.hideClosed = true;
  });
  expect(f.close().code).toBe(1);
  expect(f.readState().issue.status).toBe("closed");
  expect(f.readState().comments).toEqual([]);
  f.retained();
});

for (const kind of ["worktree", "branch"] as const)
  test(`cleanup ${kind} failure is retryable without duplicate close or comment`, () => {
    const f = fixture();
    f.cleanupFailure(kind);
    expect(f.close().code).toBe(1);
    expect(f.readState().issue.status).toBe("closed");
    expect(f.readState().comments).toEqual([expectedComment(f)]);
    expect(JSON.parse(readFileSync(f.registry, "utf8"))).toHaveLength(1);
    rmSync(join(f.root, "fail-cleanup"));
    expect(f.close().code).toBe(0);
    expect(f.writes().filter((call) => call.args[1] === "close")).toHaveLength(
      1,
    );
    expect(
      f.writes().filter((call) => call.args[1] === "comment"),
    ).toHaveLength(1);
    f.cleaned();
  });

test("retry accepts worktree and branch already removed after a verified close", () => {
  const f = fixture();
  f.cleanupFailure("worktree");
  expect(f.close().code).toBe(1);
  expect(f.readState().comments).toEqual([expectedComment(f)]);
  f.git(["worktree", "remove", f.lane]);
  f.git(["branch", "-d", "lane/one"]);
  rmSync(join(f.root, "fail-cleanup"));
  expect(f.close().code).toBe(0);
  expect(f.writes().filter((call) => call.args[1] === "close")).toHaveLength(1);
  expect(f.writes().filter((call) => call.args[1] === "comment")).toHaveLength(
    1,
  );
  f.cleaned();
});

test("close preserves a clean new commit created after preflight", () => {
  const f = fixture();
  f.change((state) => {
    state.commitOnComment = true;
  });
  const result = f.close();
  expect(result.code).toBe(1);
  expect(result.output.ok).toBe(false);
  expect(f.readState().comments).toEqual([expectedComment(f)]);
  f.retained();
  const newHead = f.git(["rev-parse", "refs/heads/lane/one"]);
  expect(newHead).not.toBe(f.head);
  expect(f.git(["rev-parse", "HEAD"], f.lane)).toBe(newHead);
  expect(
    f.git(["status", "--porcelain", "--untracked-files=all"], f.lane),
  ).toBe("");
  expect(readFileSync(join(f.lane, "change.txt"), "utf8")).toBe(
    "Clean new commit during close.\n",
  );
});
