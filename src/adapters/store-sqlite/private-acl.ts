import { chmodSync } from "node:fs";
import type { ProcessPort } from "../../ports/process.ts";

/** Windows ACL changes go through the process port, with paths in stdin JSON, never shell interpolation. */
export async function hardenPrivatePaths(
  paths: readonly string[],
  processPort: ProcessPort,
  env: Readonly<Record<string, string>>,
  platform: string = process.platform,
): Promise<void> {
  if (paths.length === 0 || paths.length > 128)
    throw new Error("Invalid ACL target count");
  if (platform !== "win32") {
    for (const path of paths) chmodSync(path, 0o600);
    return;
  }
  const executable = processPort.resolve("powershell.exe", env);
  if (executable.kind !== "resolved") throw new Error(executable.reason);
  // Progress records would otherwise share the bounded stderr with the one-line failure reason.
  const script = `$ProgressPreference='SilentlyContinue'
$ErrorActionPreference='Stop'
try {
$targets = ConvertFrom-Json ([Console]::In.ReadToEnd())
foreach ($target in $targets) {
  $item = Get-Item -LiteralPath $target -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse target refused' }
  $acl = Get-Acl -LiteralPath $target
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier])
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
  $flags = if ($item.PSIsContainer) { [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($owner,'FullControl',$flags,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
  [void]$acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $target -AclObject $acl
  $actual = Get-Acl -LiteralPath $target
  $entries = @($actual.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
  if (!$actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $owner.Value -or $entries.Count -ne 1) { throw 'Private ACL verification failed' }
  $entry = $entries[0]
  if ($entry.IdentityReference.Value -ne $owner.Value -or $entry.AccessControlType -ne 'Allow' -or $entry.FileSystemRights -ne 'FullControl' -or $entry.InheritanceFlags -ne $flags -or $entry.PropagationFlags -ne 'None' -or $entry.IsInherited) { throw 'Private ACE verification failed' }
}
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
  const result = await processPort.run(
    executable,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      cwd: process.cwd(),
      env,
      timeoutMs: 30000,
      maxOutputBytes: 4096,
      stdin: JSON.stringify(paths),
    },
  );
  if (result.exitCode !== 0 || result.timedOut || result.truncated)
    throw new Error(
      `Private ACL application or verification failed (${failureReason(result)})`,
    );
}

function failureReason(result: {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly stderr?: string;
}): string {
  if (result.timedOut) return "timed out";
  if (result.truncated) return "output exceeded its bound";
  const detail = (result.stderr ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
  return `exit ${String(result.exitCode)}: ${detail || "no error output"}`;
}
