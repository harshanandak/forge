import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { protectionFixture, timeout } from "./protect-fixture.ts";

const { temp, cleanup } = protectionFixture();
afterEach(cleanup);

const inspectAcl = `
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
$components = [Collections.Generic.Stack[string]]::new()
for ($dir = [IO.DirectoryInfo]::new($path); $null -ne $dir; $dir = $dir.Parent) {
  $components.Push($dir.FullName)
}
$accounts = @{}
foreach ($component in $components) {
  try {
    $acl = [IO.Directory]::GetAccessControl($component)
    $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
  } catch {
    $unreadable = [ordered]@{ Component = $component; OwnerSID = $null; DaclState = 'Unreadable'; Error = $_.Exception.Message }
    [Console]::WriteLine('ACL_DIAGNOSTIC ' + (ConvertTo-Json -InputObject $unreadable -Compress))
    continue
  }
  $dacl = $descriptor.DiscretionaryAcl
  $owner = [ordered]@{
    Component = $component
    OwnerSID = $descriptor.Owner.Value
    DaclState = if ($null -eq $dacl) { 'Null' } else { 'Present' }
  }
  [Console]::WriteLine('ACL_DIAGNOSTIC ' + (ConvertTo-Json -InputObject $owner -Compress))
  foreach ($ace in $dacl) {
    $sid = $null
    $account = $null
    $rights = $null
    if ($ace -is [Security.AccessControl.KnownAce]) {
      $sid = $ace.SecurityIdentifier.Value
      if (!$accounts.ContainsKey($sid)) {
        $accounts[$sid] = try { $ace.SecurityIdentifier.Translate([Security.Principal.NTAccount]).Value } catch { $null }
      }
      $account = $accounts[$sid]
      $rights = '0x{0:X8}' -f $ace.AccessMask
    }
    $entry = [ordered]@{
      SID = $sid
      AccountName = $account
      FileSystemRights = $rights
      AccessControlType = switch ($ace.AceQualifier) {
        AccessAllowed { 'Allow' }
        AccessDenied { 'Deny' }
        default { [string]$ace.AceType }
      }
      IsInherited = $ace.IsInherited
      InheritanceFlags = [string]$ace.InheritanceFlags
      PropagationFlags = [string]$ace.PropagationFlags
    }
    [Console]::WriteLine('ACL_DIAGNOSTIC ' + (ConvertTo-Json -InputObject $entry -Compress))
  }
}
`;

test.skipIf(process.platform !== "win32")(
  "prints Windows ACLs for every component of the hub temp path",
  () => {
    const executable = join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    );
    const result = spawnSync(
      executable,
      [
        "-NoProfile",
        "-NonInteractive",
        "-NoLogo",
        "-EncodedCommand",
        Buffer.from(inspectAcl, "utf16le").toString("base64"),
      ],
      {
        input: Buffer.from(realpathSync(temp())).toString("base64"),
        encoding: "utf8",
        windowsHide: true,
        shell: false,
        timeout: 20_000,
      },
    );
    if (result.stdout) console.log(result.stdout.trimEnd());
    expect(result.status, result.error?.message ?? result.stderr).toBe(0);
  },
  timeout,
);
