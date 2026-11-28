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

const creation = `function New-PrivateAcl($isDir) {
  $acl = if ($isDir) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $flags = if ($isDir) { 3 } else { 0 }
  $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid,
    [Security.AccessControl.FileSystemRights]::FullControl,
    [Security.AccessControl.InheritanceFlags]$flags,
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
  $acl
}
$published = $false
try {
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
  $request = ConvertFrom-Json -InputObject $json
  $path = $request.path
  $isDir = $request.kind -eq 'dir'
  if ($request.operation -eq 'create-dir') {
    $parent = [IO.Path]::GetDirectoryName($path)
    if (![IO.Directory]::Exists($parent)) { exit 1 }
    $staging = [IO.Path]::Combine($parent, '.forge-private-' + [Guid]::NewGuid().ToString('N'))
    $null = [IO.Directory]::CreateDirectory($staging, (New-PrivateAcl $true))
    try {
      if (!(Test-Private $staging $true)) { exit 1 }
      [IO.Directory]::Move($staging, $path)
      $published = $true
    } finally {
      if (!$published -and [IO.Directory]::Exists($staging)) { [IO.Directory]::Delete($staging) }
    }
  } elseif ($request.operation -eq 'create-file') {
    $file = [IO.FileStream]::new($path, [IO.FileMode]::CreateNew,
      [Security.AccessControl.FileSystemRights]::Write, [IO.FileShare]::None,
      4096, [IO.FileOptions]::None, (New-PrivateAcl $false))
    $file.Dispose()
  } elseif ($request.operation -eq 'harden-file') {
    if (!(Test-Private ([IO.Path]::GetDirectoryName($path)) $true)) { exit 1 }
    $acl = Read-Descriptor $path $false
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]) -ne $sid) { exit 1 }
    [IO.File]::SetAccessControl($path, (New-PrivateAcl $false))
  }
  $verifyChain = $request.operation -eq 'verify-chain'
  if ($verifyChain -and !(Test-DirectoryChain $path)) { exit 1 }
  if (!(Test-Private $path $isDir $verifyChain)) {
    if ($verifyChain) { [Console]::Error.WriteLine('chain_private:0') }
    throw 'private'
  }
  [Console]::WriteLine('private')
} catch {
  if (!$published) { exit 1 }
  [Console]::WriteLine('published_unverified')
}
`;

const baseline = "f081880b3913bae9534287431f85cae9d8c0dc67";
const predicateHash =
  "f3d13c4752c5f4cbb6bcdb0bb1a9329b65f93ef594c54d1656b890d573d92377";
const creationBaseline = "35bd606553181a52eacd4965038d2582ddb3ed89";
const creationHash =
  "ecd661ee7eecd9096617ee8237b173b26465af7e594ea9ca6547470658acd0e7";
const creationHooks = [
  [
    "      if (!(Test-Private $staging $true)) { exit 1 }\n",
    "      Invoke-Hook 'staged' $staging\n      if (!(Test-Private $staging $true)) { exit 1 }\n",
  ],
  [
    "$published = $true\n",
    "$published = $true\n      Invoke-Hook 'published' $path\n",
  ],
] as const;

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

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

export function creationReference(hooks: string): string {
  if (sha256(predicates) !== predicateHash || sha256(creation) !== creationHash)
    throw new Error(`Frozen creation helper differs from ${creationBaseline}`);
  return creationHooks.reduce(
    (script, [point, hooked]) => {
      if (script.split(point).length !== 2)
        throw new Error(`Missing creation hook point: ${point}`);
      return script.split(point).join(hooked);
    },
    predicates + hooks + creation,
  );
}

export type FrozenRun = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error | undefined;
};

export function frozenDirectoryOutcome(
  result: FrozenRun,
): boolean | "unverified" {
  const ok =
    result.status === 0 && result.error === undefined && result.stderr === "";
  const marker = ok ? result.stdout.trim() : undefined;
  return marker === "published_unverified"
    ? "unverified"
    : marker === "private";
}
