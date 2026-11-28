import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { rawDescriptorHelpers, recipes } from "./protect-windows-fixture.ts";
import {
  powershellCommand,
  readInput,
  type DiskRequest,
} from "./protect-windows-reference.ts";

const setup = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$inputData = ${readInput.replace("ReadToEnd", "ReadLine")}
$base = $inputData.base
$root = Join-Path $base 'volume'
$drive = $null
$context = 'volume root'
Add-Type @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class AclFixture {
  static Stack<Tuple<IntPtr, byte[]>> saved = new Stack<Tuple<IntPtr, byte[]>>();
  [StructLayout(LayoutKind.Sequential, Pack=4)]
  struct TokenPrivileges { public uint Count; public long Luid; public uint Attributes; }
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError=true)]
  static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool LookupPrivilegeValue(string system, string name, out long luid);
  [DllImport("advapi32.dll", SetLastError=true)]
  static extern bool AdjustTokenPrivileges(IntPtr token, bool disable, ref TokenPrivileges state, uint length, IntPtr previous, IntPtr needed);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateFile(string path, uint access, uint share, IntPtr security, uint mode, uint flags, IntPtr template);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr descriptor);
  [DllImport("advapi32.dll")] static extern int GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("advapi32.dll")]
  static extern int GetSecurityInfo(IntPtr handle, int type, uint flags, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl, out IntPtr descriptor);
  [DllImport("advapi32.dll")]
  static extern int SetSecurityInfo(IntPtr handle, int type, uint flags, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
  public static void Grant(string privilege, bool enabled) {
    IntPtr token;
    if (!OpenProcessToken(GetCurrentProcess(), 40, out token)) throw new Win32Exception();
    try {
      TokenPrivileges state = new TokenPrivileges { Count=1, Attributes=enabled ? 2u : 0u };
      if (!LookupPrivilegeValue(null, privilege, out state.Luid)) throw new Win32Exception();
      if (!AdjustTokenPrivileges(token, false, ref state, 0, IntPtr.Zero, IntPtr.Zero) ||
          Marshal.GetLastWin32Error() != 0) throw new Win32Exception();
    } finally { CloseHandle(token); }
  }
  static IntPtr Open(string path) {
    IntPtr handle = CreateFile(path, 0x000e0000, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    if (handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateFileW");
    return handle;
  }
  static byte[] Read(IntPtr handle) {
    IntPtr descriptor = IntPtr.Zero;
    try {
      int result = GetSecurityInfo(handle, 1, 5, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out descriptor);
      if (result != 0) throw new Win32Exception(result, "GetSecurityInfo: " + result);
      byte[] bytes = new byte[GetSecurityDescriptorLength(descriptor)];
      Marshal.Copy(descriptor, bytes, 0, bytes.Length);
      return bytes;
    } finally {
      if (descriptor != IntPtr.Zero) LocalFree(descriptor);
    }
  }
  static IntPtr At(IntPtr pointer, byte[] bytes, int index) {
    int offset = BitConverter.ToInt32(bytes, index);
    if (offset < 0 || offset >= bytes.Length) throw new InvalidOperationException("Invalid descriptor offset");
    return offset == 0 ? IntPtr.Zero : IntPtr.Add(pointer, offset);
  }
  static void Write(IntPtr handle, byte[] bytes) {
    if (bytes.Length < 20 || (bytes[3] & 128) == 0) throw new InvalidOperationException("Descriptor is not self-relative");
    GCHandle pin = GCHandle.Alloc(bytes, GCHandleType.Pinned);
    try {
      IntPtr pointer = pin.AddrOfPinnedObject();
      uint protect = (bytes[3] & 16) != 0 ? 0x80000000u : 0x20000000u;
      int result = SetSecurityInfo(handle, 1, 5 | protect, At(pointer, bytes, 4), IntPtr.Zero, At(pointer, bytes, 16), IntPtr.Zero);
      if (result != 0) throw new Win32Exception(result, "SetSecurityInfo: " + result);
    } finally {
      pin.Free();
    }
  }
  public static byte[] Replace(string path, byte[] bytes) {
    IntPtr handle = Open(path);
    try { saved.Push(Tuple.Create(handle, Read(handle))); }
    catch { CloseHandle(handle); throw; }
    Write(handle, bytes);
    return Read(handle);
  }
  public static void Restore() {
    var errors = new List<Exception>();
    while (saved.Count != 0) {
      var entry = saved.Pop();
      try { Write(entry.Item1, entry.Item2); }
      catch (Exception error) { errors.Add(error); }
      finally { CloseHandle(entry.Item1); }
    }
    if (errors.Count != 0) throw new AggregateException("ACL restore", errors);
  }
}
'@
${rawDescriptorHelpers}
function Set-Raw($path, $descriptor) {
  $bytes = Bytes $descriptor
  try { [Convert]::ToBase64String([AclFixture]::Replace($path, $bytes)) }
  catch { throw "$context $path descriptor=$([Convert]::ToBase64String($bytes)) $_" }
}
[AclFixture]::Grant('SeBackupPrivilege', $true)
[AclFixture]::Grant('SeRestorePrivilege', $true)
$subst = Join-Path $env:SystemRoot 'System32/subst.exe'
try {
$null = New-Item -Path $root -ItemType Directory
$safe = Raw 'O:@G:@D:P(A;OICI;FA;;;@)'
$null = Set-Raw $root $safe
$used = [IO.DriveInfo]::GetDrives().Name
$drive = 90..68 | ForEach-Object { ([char]$_).ToString() + ':' } | Where-Object { ($_.ToString() + '\\') -notin $used } | Select-Object -First 1
if (!$drive) { throw 'no free fixture drive' }
& $subst $drive $root
if ($LASTEXITCODE -ne 0) { $drive = $null; throw 'cannot mount fixture drive' }
$i = 0
$results = foreach ($recipe in $inputData.recipes) {
  $context = "row $($recipe.row) $($recipe.variant)"
  $prefix = Join-Path $root ('case-' + $i)
  $i++
  $parent = Join-Path $prefix 'parent'
  $target = Join-Path $parent 'target'
  $null = New-Item -Path $prefix, $parent -ItemType Directory
  if ($recipe.shape -eq 'file') { [IO.File]::WriteAllText($target, 'fixture') }
  elseif ($recipe.shape -in 'junction','symlink','dangling') {
    $destination = Join-Path $prefix 'destination'
    $null = New-Item -Path $destination -ItemType Directory
    if ($recipe.shape -ne 'dangling') { $null = Set-Raw $destination $safe }
    $linkType = if ($recipe.shape -eq 'symlink') { 'SymbolicLink' } else { 'Junction' }
    $null = New-Item -Path $target -ItemType $linkType -Target $destination
    if ($recipe.shape -eq 'dangling') { [IO.Directory]::Delete($destination) }
  } elseif ($recipe.shape -ne 'missing') { $null = New-Item -Path $target -ItemType Directory }
  $paths = @($target, $parent, $prefix)
  $depth = [int]$recipe.depth
  $path = $paths[$depth]
  $request = @{ path = $drive + $target.Substring($root.Length); kind = 'dir'; chain = [bool]$recipe.chain }
  if ($recipe.kind) { $request.kind = $recipe.kind }
  $stored = @()
  foreach ($level in 2..0) {
    if ($level -eq 0 -and $recipe.shape -eq 'missing') { continue }
    $descriptor = if ($level -eq $depth -and $recipe.sddl -and !$recipe.inject) { Raw $recipe.sddl } else { $safe }
    $stored += Set-Raw $paths[$level] $descriptor
  }
  if ($recipe.inject) {
    $request.fault = $drive + $path.Substring($root.Length)
    if ($recipe.inject -ne 'read') {
      $request.bytes = [Convert]::ToBase64String((Bytes (CaseDescriptor $recipe)))
    }
  }
  @{ row = $recipe.row; variant = $recipe.variant; request = $request; expected = $recipe.expected; stored = $stored }
}
[Console]::Out.WriteLine((ConvertTo-Json -InputObject @($results) -Compress -Depth 5))
$null = [Console]::In.ReadLine()
} catch {
  [Console]::Error.WriteLine($_.ToString())
  exit 1
} finally {
  try { [AclFixture]::Restore() }
  finally {
    if ($drive) {
      & $subst $drive /d
      if ($LASTEXITCODE -ne 0) { throw 'cannot unmount fixture drive' }
    }
  }
}
`;

type Observation = Pick<
  ReturnType<typeof recipes>[number],
  "row" | "variant" | "expected"
> & {
  request: DiskRequest;
  stored: string[];
};

export async function nativeFixtures(): Promise<{
  cases: Observation[];
  close(): Promise<void>;
}> {
  const runner = process.env.RUNNER_TEMP;
  if (!runner)
    throw new Error("Hosted Windows ACL comparison requires RUNNER_TEMP");
  const base = mkdtempSync(join(runner, "forge-acl-"));
  const script = join(base, "setup.ps1");
  writeFileSync(script, "\uFEFF" + setup, { flag: "wx" });
  const [file, args] = powershellCommand("-File", script);
  const child = spawn(file, args, { windowsHide: true, timeout: 55_000 });
  let errors = "";
  child.on("error", (error) => {
    errors += String(error);
  });
  child.stdin.on("error", (error) => {
    errors += String(error);
  });
  child.stderr.on("data", (data: Buffer) => {
    errors += data.toString();
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once("close", resolve);
  });
  const close = async () => {
    child.stdin.end();
    const status = await exited;
    if (status !== 0 || errors)
      throw new Error("ACL fixture helper failed: " + errors);
    rmSync(base, { recursive: true });
  };
  child.stdin.write(
    Buffer.from(JSON.stringify({ base, recipes: recipes() })).toString(
      "base64",
    ) + "\n",
  );
  const lines = createInterface({ input: child.stdout })[
    Symbol.asyncIterator
  ]();
  const first = await lines.next();
  if (first.done) {
    await close();
    throw new Error("ACL fixture helper returned no observations");
  }
  try {
    return { cases: JSON.parse(first.value) as Observation[], close };
  } catch (error) {
    await close();
    throw error;
  }
}
