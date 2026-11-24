/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { protectDirectoryChain, protectPath } from "../../src/core/index.ts";
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
  const stat = lstatSync(path, { bigint: true });
  stat.uid += 1n;
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
$inherit = if ([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::Directory) { 3 } else { 0 }
$acl = if ($inherit) { [IO.Directory]::GetAccessControl($path) } else { [IO.File]::GetAccessControl($path) }
$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]) -ne $owner -or
    !$acl.AreAccessRulesProtected -or $rules.Count -ne 1 -or
    $rules[0].IdentityReference -ne $owner -or $rules[0].IsInherited -or
    $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
    $rules[0].FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
    [int]$rules[0].InheritanceFlags -ne $inherit -or [int]$rules[0].PropagationFlags -ne 0) { exit 1 }
[Console]::WriteLine('private')
`;

function readWindowsAcl(script: string, input: string): string {
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
      "-NoLogo",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      input: Buffer.from(input).toString("base64"),
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      timeout: 8_000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  return result.stdout.trim();
}

function verifyWindowsAcl(path: string): void {
  expect(readWindowsAcl(systemPowerShellCheck, path)).toBe("private");
}

function observedWindowsProtection() {
  const diagnostics: string[] = [];
  const protector = createPathProtection({
    execute(exe, args, options) {
      const result = spawnSync(exe, args, options);
      if (result.error) diagnostics.push(result.error.message);
      if (result.stderr) diagnostics.push(result.stderr.trim());
      return result;
    },
  });
  return { protector, diagnostics };
}

test.skipIf(!windows)(
  "Q2: independently reads the owner-only Windows DACL and refuses missing and system paths",
  async () => {
    const base = temp();
    const missing = join(base, "missing");
    expect(protectPath(missing, "dir")).toBe(false);
    expect(lstatSync(missing, { throwIfNoEntry: false })).toBeUndefined();
    const { protector, diagnostics } = observedWindowsProtection();
    const dir = join(base, "private");
    expect(
      await protector.createPrivateDirectory(dir),
      diagnostics.join("\n"),
    ).toBe(true);
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

test.skipIf(windows)(
  "Directory chain refuses a symlink component and a writable non-sticky ancestor",
  () => {
    const base = realpathSync(temp());
    const ancestor = join(base, "ancestor");
    const data = join(ancestor, "data");
    mkdirSync(ancestor, { mode: 0o700 });
    mkdirSync(data, { mode: 0o700 });
    expect(protectDirectoryChain(data)).toBe(true);
    const alias = join(base, "alias");
    symlinkSync(ancestor, alias);
    expect(protectDirectoryChain(join(alias, "data"))).toBe(false);
    for (const mode of [0o770, 0o707]) {
      chmodSync(ancestor, mode);
      expect(currentMode(ancestor)).toBe(mode);
      expect(protectDirectoryChain(data)).toBe(false);
    }
    chmodSync(ancestor, 0o1777);
    expect(protectDirectoryChain(data)).toBe(true);
  },
  timeout,
);

const fixtureAcl = `
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
$request = ConvertFrom-Json -InputObject ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())))
$world = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$allow = [Security.AccessControl.AccessControlType]::Allow
$right = [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles
if ($request.grant) {
  $parent = [IO.Directory]::GetAccessControl($request.parent)
  $inheritance = if ($request.grant -eq 'inherited') { 3 } else { 0 }
  $rule = [Security.AccessControl.FileSystemAccessRule]::new($world, $right,
    [Security.AccessControl.InheritanceFlags]$inheritance,
    [Security.AccessControl.PropagationFlags]::None, $allow)
  $parent.SetAccessRule($rule)
  [IO.Directory]::SetAccessControl($request.parent, $parent)
  if ($request.grant -eq 'inherited') {
    $childAcl = [IO.Directory]::GetAccessControl($request.path)
    $childAcl.SetAccessRuleProtection($false, $false)
    [IO.Directory]::SetAccessControl($request.path, $childAcl)
  }
}
$acl = [IO.Directory]::GetAccessControl($request.path)
$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
$grant = @($rules | Where-Object { $_.IdentityReference -eq $world -and $_.AccessControlType -eq $allow })
$inherited = $request.expected -eq 'inherited'
if ($grant.Count -ne 1 -or $grant[0].IsInherited -ne $inherited -or
    $acl.AreAccessRulesProtected -eq $inherited -or
    ($grant[0].FileSystemRights -band $right) -ne $right) { exit 1 }
[Console]::WriteLine([Convert]::ToBase64String($acl.GetSecurityDescriptorBinaryForm()))
`;

test.skipIf(!windows)(
  "Windows accepts a clean chain and refuses junctions and extra leaf grants without changing DACLs",
  async () => {
    const base = temp();
    const { protector, diagnostics } = observedWindowsProtection();
    const parent = join(base, "parent");
    const child = join(parent, "child");
    expect(await protector.createPrivateDirectory(parent)).toBe(true);
    expect(await protector.createPrivateDirectory(child)).toBe(true);
    expect(protectPath(parent, "dir")).toBe(true);
    expect(protectPath(child, "dir")).toBe(true);
    expect(protector.protectDirectoryChain(child), diagnostics.join("\n")).toBe(
      true,
    );
    const junction = join(base, "alias");
    symlinkSync(parent, junction, "junction");
    expect(protector.protectDirectoryChain(join(junction, "child"))).toBe(
      false,
    );
    expect(diagnostics).toContain("chain_component:1");
    const explicit = { path: child, expected: "explicit" };
    const before = readWindowsAcl(
      fixtureAcl,
      JSON.stringify({ ...explicit, parent: child, grant: "explicit" }),
    );
    expect(before).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(protectPath(child, "dir")).toBe(false);
    expect(protector.protectDirectoryChain(child)).toBe(false);
    expect(diagnostics).toContain("chain_private:0");
    expect(readWindowsAcl(fixtureAcl, JSON.stringify(explicit))).toBe(before);
    const inheritedPath = join(parent, "inherited");
    expect(await protector.createPrivateDirectory(inheritedPath)).toBe(true);
    const inherited = { path: inheritedPath, expected: "inherited" };
    const inheritedBefore = readWindowsAcl(
      fixtureAcl,
      JSON.stringify({ ...inherited, parent, grant: "inherited" }),
    );
    expect(inheritedBefore).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(protectPath(inheritedPath, "dir")).toBe(false);
    expect(protector.protectDirectoryChain(inheritedPath)).toBe(false);
    expect(readWindowsAcl(fixtureAcl, JSON.stringify(inherited))).toBe(
      inheritedBefore,
    );
  },
  timeout,
);
