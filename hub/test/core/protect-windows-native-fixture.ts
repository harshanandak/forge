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
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
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
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetFileInformationByHandleEx(IntPtr handle, int kind, [Out] byte[] info, uint length);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool DeviceIoControl(IntPtr handle, uint code, IntPtr input, uint inputLength,
      [Out] byte[] output, uint outputLength, out uint returned, IntPtr overlapped);
  [StructLayout(LayoutKind.Sequential)]
  struct NtName { public ushort Length, Capacity; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)]
  struct ObjectAttributes {
    public int Length;
    public IntPtr Root, Name;
    public uint Flags;
    public IntPtr Security, Quality;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IoStatus { public IntPtr Status; public UIntPtr Information; }
  [StructLayout(LayoutKind.Sequential)]
  struct OverlappedData {
    public UIntPtr Internal, InternalHigh;
    public uint Offset, OffsetHigh;
    public IntPtr Event;
  }
  [DllImport("ntdll.dll", CharSet=CharSet.Unicode, ExactSpelling=true)]
  static extern int RtlDosPathNameToNtPathName_U_WithStatus(string path, out NtName name, IntPtr part, IntPtr relative);
  [DllImport("ntdll.dll")] static extern void RtlFreeUnicodeString(ref NtName name);
  [DllImport("ntdll.dll")] static extern int RtlNtStatusToDosError(int status);
  [DllImport("ntdll.dll")]
  static extern int NtOpenFile(out IntPtr handle, uint access, ref ObjectAttributes attributes, out IoStatus status, uint share, uint options);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateEvent(IntPtr attributes, bool manualReset, bool initialState, IntPtr name);
  [DllImport("kernel32.dll", EntryPoint="DeviceIoControl", SetLastError=true)]
  static extern bool DeviceIoControlOverlapped(IntPtr handle, uint code, IntPtr input, uint inputLength,
      IntPtr output, uint outputLength, IntPtr returned, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetOverlappedResult(IntPtr handle, IntPtr overlapped, out uint returned, bool wait);
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
  static IntPtr OpenNt(string path, uint access, out int status) {
    NtName name;
    status = RtlDosPathNameToNtPathName_U_WithStatus(path, out name, IntPtr.Zero, IntPtr.Zero);
    if (status != 0) return new IntPtr(-1);
    IntPtr namePointer = IntPtr.Zero;
    try {
      namePointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(NtName)));
      Marshal.StructureToPtr(name, namePointer, false);
      var attributes = new ObjectAttributes {
        Length=Marshal.SizeOf(typeof(ObjectAttributes)), Name=namePointer, Flags=0x40
      };
      IntPtr handle;
      IoStatus io;
      status = NtOpenFile(out handle, access, ref attributes, out io, 7, 0x00204000);
      return status == 0 ? handle : new IntPtr(-1);
    } finally {
      if (namePointer != IntPtr.Zero) Marshal.FreeHGlobal(namePointer);
      RtlFreeUnicodeString(ref name);
    }
  }
  static int QueryOverlappedReparse(IntPtr handle) {
    IntPtr signal = CreateEvent(IntPtr.Zero, true, false, IntPtr.Zero);
    if (signal == IntPtr.Zero) return Marshal.GetLastWin32Error();
    IntPtr output = IntPtr.Zero, context = IntPtr.Zero;
    try {
      output = Marshal.AllocHGlobal(16384);
      context = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(OverlappedData)));
      Marshal.StructureToPtr(new OverlappedData { Event=signal }, context, false);
      if (DeviceIoControlOverlapped(handle, 0x900a8, IntPtr.Zero, 0, output, 16384, IntPtr.Zero, context))
        return 0;
      int error = Marshal.GetLastWin32Error();
      if (error != 997) return error;
      uint returned;
      return GetOverlappedResult(handle, context, out returned, true) ? 0 : Marshal.GetLastWin32Error();
    } finally {
      if (context != IntPtr.Zero) Marshal.FreeHGlobal(context);
      if (output != IntPtr.Zero) Marshal.FreeHGlobal(output);
      CloseHandle(signal);
    }
  }
  public sealed class HandleProbe {
    public int OpenError, KindError, ReparseError, AclError;
    public int NtOpenStatus;
    public bool Directory;
    public string Descriptor;
  }
  public static HandleProbe Probe(string path, uint access, string opener) {
    var result = new HandleProbe();
    bool asynchronous = opener != "win32";
    uint flags = asynchronous ? 0x42200000u : 0x02200000u;
    IntPtr handle = opener == "native"
      ? OpenNt(path, access, out result.NtOpenStatus)
      : CreateFile(path, access, 7, IntPtr.Zero, 3, flags, IntPtr.Zero);
    if (handle == new IntPtr(-1)) {
      result.OpenError = opener == "native"
        ? RtlNtStatusToDosError(result.NtOpenStatus)
        : Marshal.GetLastWin32Error();
      return result;
    }
    try {
      byte[] standard = new byte[24], reparse = new byte[16384];
      if (GetFileInformationByHandleEx(handle, 1, standard, (uint)standard.Length)) result.Directory = standard[21] != 0;
      else result.KindError = Marshal.GetLastWin32Error();
      uint returned;
      if (asynchronous) result.ReparseError = QueryOverlappedReparse(handle);
      else if (!DeviceIoControl(handle, 0x900a8, IntPtr.Zero, 0, reparse, (uint)reparse.Length, out returned, IntPtr.Zero))
        result.ReparseError = Marshal.GetLastWin32Error();
      try { result.Descriptor = Convert.ToBase64String(Read(handle)); }
      catch (Win32Exception error) { result.AclError = error.NativeErrorCode; }
      return result;
    } finally { CloseHandle(handle); }
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
    if ($level -eq 0 -and $recipe.shape -in 'missing','junction','symlink','dangling') { continue }
    $descriptor = if ($level -eq $depth -and $recipe.sddl -and !$recipe.inject) { Raw $recipe.sddl } else { $safe }
    $stored += Set-Raw $paths[$level] $descriptor
  }
  if ($recipe.inject) {
    $request.fault = $drive + $path.Substring($root.Length)
    if ($recipe.inject -ne 'read') {
      $request.bytes = [Convert]::ToBase64String((Bytes (CaseDescriptor $recipe)))
    }
  }
  $probe = $null
  if ($recipe.row -eq '26') {
    $probePath = $drive + $path.Substring($root.Length)
    try {
      [AclFixture]::Grant('SeBackupPrivilege', $false)
      [AclFixture]::Grant('SeRestorePrivilege', $false)
      $probe = @{
        owner = $me
        readControl = [AclFixture]::Probe($probePath, 0x20000, 'win32')
        withAttributes = [AclFixture]::Probe($probePath, 0x20080, 'win32')
        overlapped = [AclFixture]::Probe($probePath, 0x20000, 'overlapped')
        nativeOpen = [AclFixture]::Probe($probePath, 0x20000, 'native')
      }
    } finally {
      [AclFixture]::Grant('SeBackupPrivilege', $true)
      [AclFixture]::Grant('SeRestorePrivilege', $true)
    }
  }
  @{ row = $recipe.row; variant = $recipe.variant; request = $request; expected = $recipe.expected; stored = $stored; probe = $probe }
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

export type HandleProbe = {
  OpenError: number;
  KindError: number;
  ReparseError: number;
  AclError: number;
  NtOpenStatus: number;
  Directory: boolean;
  Descriptor: string | null;
};

type Observation = Pick<
  ReturnType<typeof recipes>[number],
  "row" | "variant" | "expected"
> & {
  request: DiskRequest;
  probe: {
    owner: string;
    readControl: HandleProbe;
    withAttributes: HandleProbe;
    overlapped: HandleProbe;
    nativeOpen: HandleProbe;
  } | null;
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
