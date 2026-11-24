import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";
import { lstatSync, realpathSync, type BigIntStats } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join, resolve, win32 } from "node:path";
import type { ProtectPath } from "../contract/runtime.ts";

type Kind = "dir" | "file";
type Operation =
  "verify" | "create-dir" | "create-file" | "harden-file" | "verify-chain";

export interface PathProtection {
  readonly protectPath: ProtectPath;
  protectDirectoryChain(this: void, path: string): boolean;
  createPrivateWindowsFile(this: void, path: string): boolean;
  createPrivateDirectory(this: void, path: string): Promise<boolean>;
  createPrivateFile(this: void, path: string): Promise<FileHandle | null>;
}

export interface ProtectionDeps {
  readonly platform: NodeJS.Platform;
  readonly lstat: (path: string) => BigIntStats;
  readonly statFile: (file: FileHandle) => Promise<BigIntStats>;
  readonly geteuid: () => number | undefined;
  readonly now: () => number;
  readonly execute: (
    executable: string,
    args: readonly string[],
    options: SpawnSyncOptionsWithStringEncoding,
  ) => Pick<SpawnSyncReturns<string>, "status" | "stdout" | "stderr" | "error">;
}

export class UnverifiedDirectoryCreation extends Error {
  constructor(cause?: unknown) {
    super("Created directory could not be verified", { cause });
  }
}

const windowsHelper = `
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
function Write-ChainRefusal($path, $raw, $clause, $ace) {
  if (!$request.diagnoseChain) { return }
  $entry = [ordered]@{
    component = $path
    ownerSID = $raw.Owner.Value
    clause = $clause
    ace = if ($ace -is [Security.AccessControl.KnownAce]) {
      [ordered]@{ sid = $ace.SecurityIdentifier.Value; mask = ('0x{0:X8}' -f $ace.AccessMask); flags = [string]$ace.AceFlags }
    } else { $null }
  }
  [Console]::Error.WriteLine('HUB_WINDOWS_CHAIN_REFUSAL ' + (ConvertTo-Json -InputObject $entry -Compress -Depth 3))
}
function Assert-PathKind($path, $isDir) {
  $attributes = [IO.File]::GetAttributes($path)
  $directory = [bool]($attributes -band [IO.FileAttributes]::Directory)
  $reparse = $attributes -band [IO.FileAttributes]::ReparsePoint
  if ($directory -ne $isDir -or $reparse) {
    $clause = if ($reparse) { 'reparse' } else { 'kind' }
    Write-ChainRefusal $path $null $clause $null
    throw 'kind'
  }
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
      if ($_.Exception.Message -ne 'kind') { Write-ChainRefusal $dir.FullName $null 'descriptor' $null }
      [Console]::Error.WriteLine("chain_component:$depth")
      return $false
    }
    if ($raw.Owner.Value -notin $trusted -or $null -eq $raw.DiscretionaryAcl) {
      $clause = if ($raw.Owner.Value -notin $trusted) { 'owner' } else { 'null-dacl' }
      Write-ChainRefusal $dir.FullName $raw $clause $null
      [Console]::Error.WriteLine("chain_owner_or_dacl:$depth")
      return $false
    }
    foreach ($ace in $raw.DiscretionaryAcl) {
      if ($ace -isnot [Security.AccessControl.QualifiedAce]) {
        Write-ChainRefusal $dir.FullName $raw 'unknown-ace' $ace
        [Console]::Error.WriteLine("chain_ace:$depth")
        return $false
      }
      if ($ace.AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessAllowed -and
          !($ace.AceFlags -band [Security.AccessControl.AceFlags]::InheritOnly) -and
          $ace.SecurityIdentifier.Value -notin $trusted -and ($ace.AccessMask -band $replacement)) {
        Write-ChainRefusal $dir.FullName $raw 'replacement' $ace
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
  if ($raw.Owner -ne $sid -or $null -eq $raw.DiscretionaryAcl -or !$raw.DiscretionaryAcl.Count) {
    Write-ChainRefusal $path $raw 'leaf-owner-or-dacl' $null
    return $false
  }
  if ($strictDirectory -and (!$acl.AreAccessRulesProtected -or $raw.DiscretionaryAcl.Count -ne 1)) { return $false }
  foreach ($ace in $raw.DiscretionaryAcl) {
    if ($ace.AceType -ne [Security.AccessControl.AceType]::AccessAllowed -or $ace.SecurityIdentifier -ne $sid) {
      Write-ChainRefusal $path $raw 'leaf-owner-only' $ace
      return $false
    }
    if ($strictDirectory -and ([int]$ace.AceFlags -ne 3 -or $ace.AccessMask -ne [int][Security.AccessControl.FileSystemRights]::FullControl)) { return $false }
  }
  return $true
}
function New-PrivateAcl($isDir) {
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

const budget = 5_000;
const mode = { dir: 0o700, file: 0o600 };

function sameObject(left: BigIntStats, right: BigIntStats): boolean {
  return left.ino !== 0n && left.dev === right.dev && left.ino === right.ino;
}

function correctKind(stat: BigIntStats, kind: Kind): boolean {
  if (stat.isSymbolicLink()) return false;
  return kind === "dir"
    ? stat.isDirectory()
    : stat.isFile() && stat.nlink === 1n;
}

export function createPathProtection(
  deps: Partial<ProtectionDeps> = {},
): PathProtection {
  const {
    platform = process.platform,
    lstat = (path: string) => lstatSync(path, { bigint: true }),
    statFile = (file: FileHandle) => file.stat({ bigint: true }),
    geteuid = () => process.geteuid?.(),
    now = Date.now,
    execute = spawnSync,
  } = deps;
  const windows = platform === "win32";
  const mac = platform === "darwin";

  function run(
    executable: string,
    args: readonly string[],
    end: number,
    input = "",
  ) {
    const timeout = end - now();
    if (timeout <= 0) return undefined;
    const result = execute(executable, args, {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      maxBuffer: 32_768,
      timeout,
      input,
    });
    const ok =
      result.status === 0 && result.error === undefined && result.stderr === "";
    return ok ? result.stdout : undefined;
  }

  function win(
    path: string,
    kind: Kind,
    operation: Operation,
    end: number,
  ): boolean {
    const system = process.env.SystemRoot ?? "";
    if (process.platform === "win32" && !win32.isAbsolute(system)) return false;
    const executable = join(
      system,
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    );
    const encoded = Buffer.from(windowsHelper, "utf16le").toString("base64");
    const input = Buffer.from(
      JSON.stringify({ path, kind, operation }),
    ).toString("base64");
    const marker = run(
      executable,
      ["-NoProfile", "-NonInteractive", "-NoLogo", "-EncodedCommand", encoded],
      end,
      input,
    )?.trim();
    if (operation === "create-dir" && marker === "published_unverified")
      throw new UnverifiedDirectoryCreation();
    return marker === "private";
  }

  function safeMacAcl(
    path: string,
    kind: Kind,
    end: number,
    chainOwner?: number,
  ): boolean {
    const output = run("/bin/ls", ["-lde", path], end)?.trimEnd();
    if (output === undefined || /\r/.test(output) || /[\r\n]/.test(path))
      return false;
    const [header = "", ...entries] = output.split("\n");
    const fields = /^([d-])[rwxstST-]{9}([+@]?)\s+\d+\s/.exec(header);
    if (!fields || fields[1] !== (kind === "dir" ? "d" : "-")) return false;
    if (fields[2] === "+" && entries.length === 0) return false;
    if (chainOwner === undefined) return entries.length === 0;
    if (!fields[2] && entries.length > 0) return false;
    const nonReplacing =
      /^(?:list|search|readattr|readextattr|readsecurity|add_file|add_subdirectory|write|writeattr|writeextattr|file_inherit|directory_inherit|limit_inherit|only_inherit)$/;
    return entries.every((line, index) => {
      const entry =
        /^ (\d+): (\S+)(?: inherited)? (allow|deny) ([a-z_]+(?:,[a-z_]+)*)$/.exec(
          line,
        );
      if (entry?.[1] !== String(index)) return false;
      if (
        entry[3] === "deny" ||
        entry[4]!.split(",").every((right) => nonReplacing.test(right))
      )
        return true;
      const principal = /^user:([A-Za-z_][A-Za-z0-9_.-]*)$/.exec(
        entry[2]!,
      )?.[1];
      return (
        principal !== undefined &&
        run("/usr/bin/id", ["-u", principal], end)?.trim() ===
          String(chainOwner)
      );
    });
  }

  function verified(
    path: string,
    kind: Kind,
    end: number,
    known?: BigIntStats,
  ): boolean {
    const stat = lstat(path);
    if (!correctKind(stat, kind)) return false;
    if (known !== undefined && !sameObject(known, stat)) return false;
    if (windows) {
      if (!win(path, kind, "verify", end)) return false;
    } else {
      if (
        Number(stat.uid) !== geteuid() ||
        Number(stat.mode & 0o7777n) !== mode[kind]
      )
        return false;
      if (mac && !safeMacAcl(path, kind, end)) return false;
    }
    const after = lstat(path);
    return (
      sameObject(stat, after) &&
      correctKind(after, kind) &&
      after.uid === stat.uid &&
      after.mode === stat.mode
    );
  }

  async function removeCreated(
    path: string,
    identity: BigIntStats | undefined,
    remove: (path: string) => Promise<void>,
  ) {
    try {
      if (identity && sameObject(identity, lstat(path))) await remove(path);
    } catch {
      return;
    }
  }

  return {
    protectDirectoryChain(path) {
      try {
        const target = resolve(path);
        if (windows) return win(target, "dir", "verify-chain", now() + budget);
        let component = realpathSync(target);
        const owner = geteuid();
        if (component !== target || owner === undefined) return false;
        const end = now() + budget;
        for (;;) {
          const stat = lstat(component);
          const uid = Number(stat.uid);
          if (
            !stat.isDirectory() ||
            (uid !== owner && uid !== 0) ||
            ((stat.mode & 0o022n) !== 0n && (stat.mode & 0o1000n) === 0n)
          )
            return false;
          if (mac && !safeMacAcl(component, "dir", end, uid)) return false;
          const parent = dirname(component);
          if (parent === component) return true;
          component = parent;
        }
      } catch {
        return false;
      }
    },
    protectPath(path, kind) {
      try {
        return verified(resolve(path), kind, now() + budget);
      } catch {
        return false;
      }
    },
    createPrivateWindowsFile(path) {
      if (!windows) return false;
      return win(resolve(path), "file", "create-file", now() + budget);
    },
    async createPrivateDirectory(path) {
      const target = resolve(path);
      let created: BigIntStats | undefined;
      let made = false;
      try {
        const end = now() + budget;
        if (windows) return win(target, "dir", "create-dir", end);
        await mkdir(target, { mode: mode.dir });
        made = true;
        const identity = lstat(target);
        const owned = Number(identity.uid) === geteuid();
        if (!owned || !identity.ino || !correctKind(identity, "dir"))
          throw new UnverifiedDirectoryCreation();
        created = identity;
        await chmod(target, mode.dir);
        if (mac && run("/bin/chmod", ["-N", target], end) === undefined)
          return false;
        if (!verified(target, "dir", end, created)) return false;
        created = undefined;
        return true;
      } catch (error) {
        if (error instanceof UnverifiedDirectoryCreation) throw error;
        if (made && created === undefined)
          throw new UnverifiedDirectoryCreation(error);
        return false;
      } finally {
        if (created !== undefined) await removeCreated(target, created, rmdir);
      }
    },
    async createPrivateFile(path) {
      const target = resolve(path);
      const parent = dirname(target);
      let file: FileHandle | undefined;
      let identity: BigIntStats | undefined;
      try {
        const end = now() + budget;
        if (!verified(parent, "dir", end)) return null;
        file = await open(target, "wx", mode.file);
        identity = await statFile(file);
        const current = lstat(target);
        if (!correctKind(current, "file") || !sameObject(identity, current))
          return null;
        if (windows) {
          if (
            !win(target, "file", "harden-file", end) ||
            !sameObject(identity, lstat(target))
          )
            return null;
        } else {
          await file.chmod(mode.file);
          if (mac && run("/bin/chmod", ["-N", target], end) === undefined)
            return null;
          if (!verified(target, "file", end, identity)) return null;
        }
        const accepted = file;
        file = undefined;
        return accepted;
      } catch {
        return null;
      } finally {
        if (file !== undefined) {
          await file.close().catch(() => undefined);
          await removeCreated(target, identity, unlink);
        }
      }
    },
  };
}

let defaultInstance: PathProtection | undefined;
const defaultProtection = () => (defaultInstance ??= createPathProtection());

export const protectPath: ProtectPath = (path, kind) =>
  defaultProtection().protectPath(path, kind);
export const protectDirectoryChain: PathProtection["protectDirectoryChain"] = (
  path,
) => defaultProtection().protectDirectoryChain(path);
export const createPrivateWindowsFile: PathProtection["createPrivateWindowsFile"] =
  (path) => defaultProtection().createPrivateWindowsFile(path);
export const createPrivateDirectory: PathProtection["createPrivateDirectory"] =
  (path) => defaultProtection().createPrivateDirectory(path);
export const createPrivateFile: PathProtection["createPrivateFile"] = (path) =>
  defaultProtection().createPrivateFile(path);
