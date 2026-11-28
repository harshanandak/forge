import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const predicates = `
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
function Assert-PathKind($path, $isDir) {
  $attributes = [IO.File]::GetAttributes($path)
  $directory = [bool]([int]$attributes -band [int][IO.FileAttributes]::Directory)
  if ($directory -ne $isDir -or ([int]$attributes -band [int][IO.FileAttributes]::ReparsePoint)) { throw 'kind' }
}
function Read-Descriptor($path, $isDir) {
  Assert-PathKind $path $isDir
  if ($isDir) { [IO.Directory]::GetAccessControl($path) } else { [IO.File]::GetAccessControl($path) }
}
function Test-DirectoryChain($path) {
  $trusted = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544',
    'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  $replacement = 0x10000 -bor 0x40 -bor 0x40000 -bor 0x80000 -bor 0x40000000 -bor 0x10000000
  $depth = 0
  for ($dir = [IO.DirectoryInfo]::new($path); $null -ne $dir; $dir = $dir.Parent) {
    try {
      $acl = Read-Descriptor $dir.FullName $true
      $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
    } catch {
      [Console]::Error.WriteLine("chain_component:$depth")
      return $false
    }
    if ($raw.Owner.Value -notin $trusted -or $null -eq $raw.DiscretionaryAcl) {
      [Console]::Error.WriteLine("chain_owner_or_dacl:$depth")
      return $false
    }
    foreach ($ace in $raw.DiscretionaryAcl) {
      if ($ace -isnot [Security.AccessControl.QualifiedAce]) {
        [Console]::Error.WriteLine("chain_ace:$depth")
        return $false
      }
      if ($ace.AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessAllowed -and
          !([int]$ace.AceFlags -band [int][Security.AccessControl.AceFlags]::InheritOnly) -and
          $ace.SecurityIdentifier.Value -notin $trusted -and ($ace.AccessMask -band $replacement)) {
        [Console]::Error.WriteLine("chain_replacement:$depth")
        return $false
      }
    }
    $depth += 1
  }
  return $true
}
function Test-Private($path, $isDir, $effectiveOnly = $false) {
  $acl = Read-Descriptor $path $isDir
  $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
  $strictDirectory = $isDir -and !$effectiveOnly
  if ($raw.Owner -ne $sid -or $null -eq $raw.DiscretionaryAcl -or !$raw.DiscretionaryAcl.Count) { return $false }
  if ($strictDirectory -and (!$acl.AreAccessRulesProtected -or $raw.DiscretionaryAcl.Count -ne 1)) { return $false }
  foreach ($ace in $raw.DiscretionaryAcl) {
    if ($ace.AceType -ne [Security.AccessControl.AceType]::AccessAllowed -or $ace.SecurityIdentifier -ne $sid) { return $false }
    if ($strictDirectory -and ([int]$ace.AceFlags -ne 3 -or $ace.AccessMask -ne [int][Security.AccessControl.FileSystemRights]::FullControl)) { return $false }
  }
  return $true
}
`;

const baseline = "f081880b3913bae9534287431f85cae9d8c0dc67";
const predicateHash =
  "f3d13c4752c5f4cbb6bcdb0bb1a9329b65f93ef594c54d1656b890d573d92377";

export type Request = {
  path: string;
  kind: "dir" | "file";
  chain: boolean;
  descriptors: Record<string, { directory: boolean; bytes: string }>;
};

export type DiskRequest = Omit<Request, "descriptors"> & {
  fault?: string;
  bytes?: string;
};

export function powershellCommand(...scriptArgs: string[]) {
  return [
    join(
      process.env.SystemRoot ?? "C:/Windows",
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    ),
    ["-NoProfile", "-NonInteractive", "-NoLogo", ...scriptArgs],
  ] as const;
}

export function powershell<T>(
  script: string,
  input: unknown,
  timeout: number,
): T {
  const [file, args] = powershellCommand(
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  );
  const result = spawnSync(file, args, {
    encoding: "utf8",
    timeout,
    windowsHide: true,
    input: Buffer.from(JSON.stringify(input)).toString("base64"),
  });
  if (result.error || result.status !== 0 || result.stderr)
    throw new Error(
      `PowerShell fixture failed: ${result.status} ${result.stderr} ${String(result.error)}`,
    );
  return JSON.parse(result.stdout) as T;
}

export const readInput =
  "[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())) | ConvertFrom-Json";

export function reference(
  requests: (Request | DiskRequest)[],
): { ok: boolean; diagnostic: string }[] {
  if (createHash("sha256").update(predicates).digest("hex") !== predicateHash)
    throw new Error(`Frozen helper differs from ${baseline}`);
  return powershell(
    predicates +
      `
$requests = ${readInput}
Set-Item Function:Read-NtfsDescriptor \${function:Read-Descriptor}
function Read-Descriptor($path, $isDir) {
  if ($request.descriptors) {
    $entry = $request.descriptors.$path
    if (!$entry -or $entry.directory -ne $isDir) { throw 'kind' }
    $bytes = $entry.bytes
  } else {
    if ($path -ne $request.fault) { return Read-NtfsDescriptor $path $isDir }
    $bytes = $request.bytes
    if (!$bytes) { throw 'injected read failure' }
  }
  $acl = if ($isDir) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
  $acl.SetSecurityDescriptorBinaryForm([Convert]::FromBase64String($bytes))
  $acl
}
$results = foreach ($request in $requests) {
  $diagnostic = [IO.StringWriter]::new()
  [Console]::SetError($diagnostic)
  $passed = $false
  try {
    if (!$request.chain -or (Test-DirectoryChain $request.path)) {
      $passed = Test-Private $request.path ($request.kind -eq 'dir') $request.chain
      if (!$passed -and $request.chain) { [Console]::Error.WriteLine('chain_private:0') }
    }
  } catch {}
  @{ ok = $passed; diagnostic = $diagnostic.ToString().Trim() }
}
ConvertTo-Json -InputObject @($results) -Compress
`,
    requests,
    5_000,
  );
}
