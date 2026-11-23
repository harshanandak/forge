/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { protectPath } from "../../src/core/index.ts";
import {
  createPathProtection,
  type PathProtection,
  type ProtectionDeps,
} from "../../src/core/protect.ts";

const timeout = 30_000;
const windows = process.platform === "win32";
const dirs: string[] = [];
const fileText = "stored data";

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-hub-protect-"));
  dirs.push(dir);
  return dir;
}

function currentMode(path: string): number {
  return lstatSync(path).mode & 0o7777;
}

function fakeOwner(path: string) {
  const stat = lstatSync(path);
  stat.uid = stat.uid + 1;
  return stat;
}

function fakeMacStat(path: string) {
  const stat = lstatSync(path);
  stat.uid = 123;
  stat.mode = (stat.mode & ~0o7777) | (stat.isDirectory() ? 0o700 : 0o600);
  return stat;
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

test.skipIf(windows)(
  "Q1: verifies POSIX mode and owner without creating a missing object",
  () => {
    const dir = temp();
    const file = join(dir, "private-file");
    writeFileSync(file, fileText, { mode: 0o600 });
    const missing = join(dir, "missing");
    expect(protectPath(dir, "dir")).toBe(true);
    expect(protectPath(file, "file")).toBe(true);
    expect(currentMode(dir)).toBe(0o700);
    expect(currentMode(file)).toBe(0o600);
    expect(protectPath(missing, "file")).toBe(false);
    expect(lstatSync(missing, { throwIfNoEntry: false })).toBeUndefined();
    const foreign = createPathProtection({ lstat: fakeOwner });
    expect(foreign.protectPath(file, "file")).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(fileText);
  },
  timeout,
);

const systemPowerShellCheck = `
$ErrorActionPreference = 'Stop'
$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $path
$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
$inherit = if ((Get-Item -LiteralPath $path).PSIsContainer) { 3 } else { 0 }
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]) -ne $owner -or
    !$acl.AreAccessRulesProtected -or $rules.Count -ne 1 -or
    $rules[0].IdentityReference -ne $owner -or $rules[0].IsInherited -or
    $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
    $rules[0].FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
    [int]$rules[0].InheritanceFlags -ne $inherit -or [int]$rules[0].PropagationFlags -ne 0) { exit 1 }
[Console]::WriteLine('private')
`;

function verifyWindowsAcl(path: string): void {
  const executable = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const result = spawnSync(
    executable,
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(systemPowerShellCheck, "utf16le").toString("base64"),
    ],
    {
      input: Buffer.from(path).toString("base64"),
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      timeout: 8_000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("private");
  expect(result.stderr).toBe("");
}

test.skipIf(!windows)(
  "Q2: independently reads the owner-only Windows DACL and refuses missing and system paths",
  async () => {
    const base = temp();
    const missing = join(base, "missing");
    expect(protectPath(missing, "dir")).toBe(false);
    expect(lstatSync(missing, { throwIfNoEntry: false })).toBeUndefined();
    const protector = createPathProtection();
    const dir = join(base, "private");
    expect(await protector.createPrivateDirectory(dir)).toBe(true);
    const path = join(dir, "private-file");
    const file = await protector.createPrivateFile(path);
    if (file === null) throw new Error("Expected a private file");
    try {
      await file.writeFile(fileText);
      expect(protectPath(dir, "dir")).toBe(true);
      expect(protectPath(path, "file")).toBe(true);
      verifyWindowsAcl(dir);
      verifyWindowsAcl(path);
      expect(
        protectPath(
          join(
            process.env.SystemRoot ?? "C:\\Windows",
            "System32",
            "ntoskrnl.exe",
          ),
          "file",
        ),
      ).toBe(false);
    } finally {
      await file.close();
    }
    expect(readFileSync(path, "utf8")).toBe(fileText);
  },
  timeout,
);

test.skipIf(windows)(
  "PP1: refuses POSIX links, wrong kinds and owners, and broad modes untouched",
  () => {
    const dir = temp();
    const privateDir = join(dir, "private");
    mkdirSync(privateDir, { mode: 0o700 });
    const link = join(dir, "dir-link");
    symlinkSync(privateDir, link);
    expect(protectPath(link, "dir")).toBe(false);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(currentMode(privateDir)).toBe(0o700);
    const fifo = join(dir, "fifo");
    execFileSync("mkfifo", [fifo], { timeout: 4_000 });
    expect(protectPath(fifo, "file")).toBe(false);
    expect(lstatSync(fifo).isFIFO()).toBe(true);
    const foreign = createPathProtection({ lstat: fakeOwner });
    expect(foreign.protectPath(privateDir, "dir")).toBe(false);
    const broadDir = join(dir, "broad");
    const broadFile = join(dir, "broad-file");
    mkdirSync(broadDir);
    writeFileSync(broadFile, fileText);
    chmodSync(broadDir, 0o755);
    chmodSync(broadFile, 0o644);
    expect(protectPath(broadDir, "dir")).toBe(false);
    expect(protectPath(broadFile, "file")).toBe(false);
    expect(currentMode(broadDir)).toBe(0o755);
    expect(currentMode(broadFile)).toBe(0o644);
    expect(readFileSync(broadFile, "utf8")).toBe(fileText);
  },
  timeout,
);

const noMacAcl = "drwx------  2 owner group 64 Nov 23 12:00 private\n";
const macAcl =
  "drwx------+ 2 owner group 64 Nov 23 12:00 private\n 0: user:other allow read\n";

test(
  "PP2: accepts macOS read-back only for a private path without ACL entries",
  () => {
    const path = temp();
    for (const [stdout, expected] of [
      [noMacAcl, true],
      [macAcl, false],
      ["unparseable\n", false],
    ] as const) {
      const calls: [string, readonly string[]][] = [];
      const mac = createPathProtection({
        platform: "darwin",
        lstat: fakeMacStat,
        geteuid: () => 123,
        now: () => 100,
        execute(exe, args, options) {
          calls.push([exe, args]);
          expect(options.shell).toBe(false);
          return { status: 0, stdout, stderr: "" };
        },
      });
      expect(mac.protectPath(path, "dir")).toBe(expected);
      expect(calls).toEqual([["/bin/ls", ["-lde", path]]]);
    }
  },
  timeout,
);

test(
  "PP3: Windows verification refuses extra and inherited ACEs, timeout and non-protocol output",
  () => {
    const path = resolve(temp(), "name [with spaces] & apostrophe's file");
    writeFileSync(path, fileText);
    type Result = ReturnType<ProtectionDeps["execute"]>;
    const cases: readonly [string, Result, boolean][] = [
      [
        "protected owner-only DACL",
        { status: 0, stdout: "private\n", stderr: "" },
        true,
      ],
      ["extra ACE", { status: 1, stdout: "refused\n", stderr: "" }, false],
      ["inherited ACE", { status: 1, stdout: "refused\n", stderr: "" }, false],
      [
        "timeout",
        { status: null, stdout: "", stderr: "", error: new Error("timeout") },
        false,
      ],
      [
        "unexpected response",
        { status: 0, stdout: "unparseable\n", stderr: "" },
        false,
      ],
    ];
    for (const [reason, result, expected] of cases) {
      let called = false;
      const protector = createPathProtection({
        platform: "win32",
        now: () => 100,
        execute(exe, args, options) {
          called = true;
          expect(exe.toLowerCase()).toEndWith("powershell.exe");
          expect(args).toContain("-NoProfile");
          expect(args).toContain("-NonInteractive");
          expect(options.windowsHide).toBe(true);
          expect(options.shell).toBe(false);
          expect(options.timeout).toBeGreaterThan(0);
          expect(options.timeout).toBeLessThan(timeout);
          const command = args[args.indexOf("-EncodedCommand") + 1];
          if (command === undefined)
            throw new Error("Expected a fixed PowerShell command");
          expect(
            Buffer.from(command, "base64").toString("utf16le"),
          ).not.toContain(path);
          const { input } = options;
          if (typeof input !== "string")
            throw new Error("Expected encoded path data");
          const data = Buffer.from(input, "base64").toString("utf8");
          expect(data).toContain(JSON.stringify(path));
          return result;
        },
      });
      expect(protector.protectPath(path, "file"), reason).toBe(expected);
      expect(called).toBe(true);
    }
    expect(readFileSync(path, "utf8")).toBe(fileText);
  },
  timeout,
);

async function verifyCreation(
  protector: PathProtection,
  base: string,
): Promise<void> {
  const dir = join(base, "private-dir");
  const path = join(dir, "private-file");
  expect(await protector.createPrivateDirectory(dir)).toBe(true);
  expect(protector.protectPath(dir, "dir")).toBe(true);
  const file = await protector.createPrivateFile(path);
  if (file === null) throw new Error("Expected a private file");
  try {
    expect(protector.protectPath(path, "file")).toBe(true);
    await file.writeFile(fileText);
    expect(await protector.createPrivateDirectory(dir)).toBe(false);
    expect(await protector.createPrivateFile(path)).toBeNull();
    expect(protector.protectPath(dir, "dir")).toBe(true);
    expect(protector.protectPath(path, "file")).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(fileText);
  } finally {
    await file.close();
  }
}

test.skipIf(windows)(
  "K11 (POSIX): creates private paths and refuses to replace them",
  async () => {
    await verifyCreation(createPathProtection(), temp());
  },
  timeout,
);

test(
  "K11 (macOS): removes ACLs from new objects and verifies them before use",
  async () => {
    const cleared = new Set<string>();
    const parent = temp();
    const dir = join(parent, "private-dir");
    const file = join(dir, "private-file");
    const mac = createPathProtection({
      platform: "darwin",
      lstat: fakeMacStat,
      geteuid: () => 123,
      now: () => 100,
      execute(exe, args, options) {
        expect(options.shell).toBe(false);
        const path = args[1];
        if (path === undefined) throw new Error("Expected path argument");
        if (exe === "/bin/chmod") {
          expect(args).toEqual(["-N", path]);
          expect(cleared.has(path)).toBe(false);
          cleared.add(path);
          return { status: 0, stdout: "", stderr: "" };
        }
        expect(exe).toBe("/bin/ls");
        expect(args).toEqual(["-lde", path]);
        const header = lstatSync(path).isDirectory()
          ? noMacAcl
          : noMacAcl.replace(/^d/, "-");
        return {
          status: 0,
          stdout: path === parent || cleared.has(path) ? header : macAcl,
          stderr: "",
        };
      },
    });
    await verifyCreation(mac, parent);
    expect(cleared).toEqual(new Set([dir, file]));
  },
  timeout,
);

test.skipIf(!windows)(
  "K11 (Windows): creates and reads back private paths without replacing them",
  async () => {
    const base = temp();
    await verifyCreation(createPathProtection(), base);
    const dir = join(base, "private-dir");
    verifyWindowsAcl(dir);
    verifyWindowsAcl(join(dir, "private-file"));
  },
  timeout,
);
