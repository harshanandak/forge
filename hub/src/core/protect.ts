import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";
import { lstatSync, type Stats } from "node:fs";
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
type Operation = "verify" | "create-dir" | "harden-file";

export interface PathProtection {
  readonly protectPath: ProtectPath;
  createPrivateDirectory(this: void, path: string): Promise<boolean>;
  createPrivateFile(this: void, path: string): Promise<FileHandle | null>;
}

export interface ProtectionDeps {
  readonly platform: NodeJS.Platform;
  readonly lstat: (path: string) => Stats;
  readonly geteuid: () => number | undefined;
  readonly now: () => number;
  readonly execute: (
    executable: string,
    args: readonly string[],
    options: SpawnSyncOptionsWithStringEncoding,
  ) => Pick<SpawnSyncReturns<string>, "status" | "stdout" | "stderr" | "error">;
}

const windowsHelper = `
$ErrorActionPreference = 'Stop'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
function Read-Descriptor($path, $isDir) {
  $item = Get-Item -LiteralPath $path -Force
  if ($item.PSIsContainer -ne $isDir -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'kind' }
  Get-Acl -LiteralPath $path
}
function Test-Private($path, $isDir) {
  $acl = Read-Descriptor $path $isDir
  $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
  if ($raw.Owner -ne $sid -or !$acl.AreAccessRulesProtected -or $null -eq $raw.DiscretionaryAcl -or $raw.DiscretionaryAcl.Count -ne 1) { return $false }
  $ace = $raw.DiscretionaryAcl[0]
  $flags = if ($isDir) { 3 } else { 0 }
  return ($ace.AceType -eq [Security.AccessControl.AceType]::AccessAllowed -and
    $ace.SecurityIdentifier -eq $sid -and [int]$ace.AceFlags -eq $flags -and
    $ace.AccessMask -eq [int][Security.AccessControl.FileSystemRights]::FullControl)
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
try {
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
  $request = ConvertFrom-Json -InputObject $json
  $path = $request.path
  $isDir = $request.kind -eq 'dir'
  if ($request.operation -eq 'create-dir') {
    if (Test-Path -LiteralPath $path) { exit 1 }
    $parent = [IO.Path]::GetDirectoryName($path)
    $staging = [IO.Path]::Combine($parent, '.forge-private-' + [Guid]::NewGuid().ToString('N'))
    $null = [IO.Directory]::CreateDirectory($staging, (New-PrivateAcl $true))
    try {
      if (!(Test-Private $staging $true)) { exit 1 }
      [IO.Directory]::Move($staging, $path)
    } finally {
      if ([IO.Directory]::Exists($staging)) { [IO.Directory]::Delete($staging) }
    }
  } elseif ($request.operation -eq 'harden-file') {
    if (!(Test-Private ([IO.Path]::GetDirectoryName($path)) $true)) { exit 1 }
    $acl = Read-Descriptor $path $false
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]) -ne $sid) { exit 1 }
    Set-Acl -LiteralPath $path -AclObject (New-PrivateAcl $false)
  }
  if (!(Test-Private $path $isDir)) { exit 1 }
  [Console]::WriteLine('private')
} catch { exit 1 }
`;

const budget = 5_000;
const mode = { dir: 0o700, file: 0o600 };

function sameObject(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function correctKind(stat: Stats, kind: Kind): boolean {
  return (
    !stat.isSymbolicLink() &&
    (kind === "dir" ? stat.isDirectory() : stat.isFile() && stat.nlink === 1)
  );
}

export function createPathProtection(
  deps: Partial<ProtectionDeps> = {},
): PathProtection {
  const {
    platform = process.platform,
    lstat = lstatSync,
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
    return (
      run(
        executable,
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        end,
        input,
      )?.trim() === "private"
    );
  }

  function noAcl(path: string, kind: Kind, end: number): boolean {
    const output = run("/bin/ls", ["-lde", path], end)?.trimEnd();
    const prefix = kind === "dir" ? "d" : "-";
    if (output === undefined || /[\r\n]/.test(output)) return false;
    return (
      output.startsWith(prefix) && /^[d-][rwxstST-]{9}@?\s+\d+\s/.test(output)
    );
  }

  function verified(
    path: string,
    kind: Kind,
    end: number,
    known?: Stats,
  ): boolean {
    const stat = lstat(path);
    if (!correctKind(stat, kind)) return false;
    if (known !== undefined && !sameObject(known, stat)) return false;
    if (windows) {
      if (!win(path, kind, "verify", end)) return false;
    } else {
      if (stat.uid !== geteuid() || (stat.mode & 0o7777) !== mode[kind])
        return false;
      if (mac && !noAcl(path, kind, end)) return false;
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
    identity: Stats | undefined,
    remove: (path: string) => Promise<void>,
  ) {
    try {
      if (identity === undefined || sameObject(identity, lstat(path)))
        await remove(path);
    } catch {
      return;
    }
  }

  return {
    protectPath(path, kind) {
      try {
        return verified(resolve(path), kind, now() + budget);
      } catch {
        return false;
      }
    },
    async createPrivateDirectory(path) {
      const target = resolve(path);
      let created: Stats | undefined;
      try {
        const end = now() + budget;
        if (windows) return win(target, "dir", "create-dir", end);
        await mkdir(target, { mode: mode.dir });
        created = lstat(target);
        if (!correctKind(created, "dir") || created.uid !== geteuid())
          return false;
        await chmod(target, mode.dir);
        if (mac && run("/bin/chmod", ["-N", target], end) === undefined)
          return false;
        if (!verified(target, "dir", end, created)) return false;
        created = undefined;
        return true;
      } catch {
        return false;
      } finally {
        if (created !== undefined) await removeCreated(target, created, rmdir);
      }
    },
    async createPrivateFile(path) {
      const target = resolve(path);
      const parent = dirname(target);
      let file: FileHandle | undefined;
      let identity: Stats | undefined;
      try {
        const end = now() + budget;
        if (!verified(parent, "dir", end)) return null;
        file = await open(target, "wx", mode.file);
        identity = await file.stat();
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

export const { protectPath, createPrivateDirectory, createPrivateFile } =
  createPathProtection();
