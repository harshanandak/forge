/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { protectPath } from "../../src/core/index.ts";
import { createPathProtection } from "../../src/core/protect.ts";
import {
  fileText,
  protectionFixture,
  timeout,
  verifyCreation,
} from "./protect-fixture.ts";

const windows = process.platform === "win32";
const { temp, cleanup } = protectionFixture();

afterEach(cleanup);

function currentMode(path: string): number {
  return lstatSync(path).mode & 0o7777;
}

function fakeOwner(path: string) {
  const stat = lstatSync(path);
  stat.uid = stat.uid + 1;
  return stat;
}

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
$ProgressPreference = 'SilentlyContinue'
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

test.skipIf(windows)(
  "K11 (POSIX): creates private paths and refuses to replace them",
  async () => {
    await verifyCreation(createPathProtection(), temp());
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
