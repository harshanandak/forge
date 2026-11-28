import { win32 } from "node:path";
import type { WindowsSecurityReader } from "../contract/windows-security.ts";

const readControl = 0x00020000;
const shareAll = 7;
const openReparsePoint = 0x00200000;
const openForBackupIntent = 0x00004000;
const caseInsensitive = 0x40;
const fileStandardInfo = 1;
const getReparsePoint = 0x000900a8;
const ioPending = 997;
const notAReparsePoint = 4390;

async function openNative(): Promise<WindowsSecurityReader> {
  if (process.platform !== "win32") throw new Error("Windows required");
  const system = process.env.SystemRoot ?? "";
  if (!win32.isAbsolute(system)) throw new Error("SystemRoot is unavailable");
  const koffi = await import("koffi");
  const dll = (name: string) =>
    koffi.load(win32.join(system, "System32", `${name}.dll`));
  const nt = dll("ntdll");
  const security = dll("advapi32");
  const kernel32 = dll("kernel32");
  const ntName = koffi.struct({
    length: "uint16_t",
    capacity: "uint16_t",
    buffer: "void *",
  });
  const objectAttributes = koffi.struct({
    length: "uint32_t",
    root: "void *",
    name: koffi.pointer(ntName),
    flags: "uint32_t",
    security: "void *",
    quality: "void *",
  });
  const overlapped = koffi.struct({
    internal: "uintptr_t",
    internalHigh: "uintptr_t",
    offset: "uint32_t",
    offsetHigh: "uint32_t",
    event: "void *",
  });
  const convertPath = nt.func(
    "int32_t __stdcall RtlDosPathNameToNtPathName_U_WithStatus(str16 path, void *name, void *filePart, void *relative)",
  );
  const freePath = nt.func("void __stdcall RtlFreeUnicodeString(void *name)");
  const openFile = nt.func("__stdcall", "NtOpenFile", "int32_t", [
    koffi.out(koffi.pointer("void *")),
    "uint32_t",
    koffi.pointer(objectAttributes),
    "void *",
    "uint32_t",
    "uint32_t",
  ]);
  const statusToError = nt.func(
    "uint32_t __stdcall RtlNtStatusToDosError(int32_t status)",
  );
  const fileInfo = kernel32.func(
    "int __stdcall GetFileInformationByHandleEx(void *handle, int kind, void *info, uint32_t size)",
  );
  const createEvent = kernel32.func(
    "void * __stdcall CreateEventW(void *attributes, int manualReset, int initialState, str16 name)",
  );
  const control = kernel32.func(
    "int __stdcall DeviceIoControl(void *handle, uint32_t code, void *input, uint32_t inputSize, void *output, uint32_t outputSize, void *returned, void *overlapped)",
  );
  const wait = kernel32.func(
    "int __stdcall GetOverlappedResult(void *handle, void *overlapped, _Out_ uint32_t *returned, int wait)",
  );
  const lastError = kernel32.func("uint32_t __stdcall GetLastError()");
  const getSecurity = security.func(
    "uint32_t __stdcall GetSecurityInfo(void *handle, int type, uint32_t flags, void *owner, void *group, void *dacl, void *sacl, _Out_ void **descriptor)",
  );
  const descriptorSize = security.func(
    "uint32_t __stdcall GetSecurityDescriptorLength(void *descriptor)",
  );
  const sidSize = security.func("uint32_t __stdcall GetLengthSid(void *sid)");
  const free = kernel32.func("void * __stdcall LocalFree(void *allocation)");
  const current = kernel32.func("void * __stdcall GetCurrentProcess()");
  const close = kernel32.func("int __stdcall CloseHandle(void *handle)");
  const openToken = security.func(
    "int __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ void **token)",
  );
  const tokenInfo = security.func(
    "int __stdcall GetTokenInformation(void *token, int kind, void *buffer, uint32_t size, _Out_ uint32_t *length)",
  );

  function bytesFrom(pointer: unknown, length: number, maximum: number) {
    if (!pointer || length < 8 || length > maximum)
      throw new Error("Invalid native Windows security data");
    const bytes: unknown = koffi.decode(pointer, "uint8_t", length);
    if (!(bytes instanceof Uint8Array))
      throw new Error("Cannot copy native Windows security data");
    return Buffer.from(bytes);
  }

  function openNoFollow(path: string) {
    const name = Buffer.alloc(koffi.sizeof(ntName));
    const converted = Number(convertPath(path, name, null, null));
    if (converted !== 0)
      throw new Error(
        `Cannot convert Windows path: ${statusToError(converted)}`,
      );
    try {
      const handle: unknown[] = [null];
      const statusBlock = Buffer.alloc(2 * koffi.sizeof("void *"));
      const status = Number(
        openFile(
          handle,
          readControl,
          {
            length: koffi.sizeof(objectAttributes),
            root: null,
            name,
            flags: caseInsensitive,
            security: null,
            quality: null,
          },
          statusBlock,
          shareAll,
          openReparsePoint | openForBackupIntent,
        ),
      );
      if (status !== 0 || !handle[0])
        throw new Error(`Cannot open Windows path: ${statusToError(status)}`);
      return handle[0];
    } finally {
      freePath(name);
    }
  }

  function verifyKind(handle: unknown, directory: boolean) {
    const info = Buffer.alloc(24);
    if (
      !fileInfo(handle, fileStandardInfo, info, info.length) ||
      Boolean(info[21]) !== directory
    )
      throw new Error("Unexpected Windows path kind");
    const event: unknown = createEvent(null, 1, 0, null);
    if (!event) throw new Error("Cannot create Windows I/O event");
    try {
      const data = Buffer.alloc(16 * 1024);
      const operation = Buffer.alloc(koffi.sizeof(overlapped));
      koffi.encode(operation, overlapped, {
        internal: 0,
        internalHigh: 0,
        offset: 0,
        offsetHigh: 0,
        event,
      });
      const found = Boolean(
        control(
          handle,
          getReparsePoint,
          null,
          0,
          data,
          data.length,
          null,
          operation,
        ),
      );
      let error = found ? 0 : Number(lastError());
      if (error === ioPending)
        error = wait(handle, operation, [0], 1) ? 0 : Number(lastError());
      data.fill(0);
      if (error !== notAReparsePoint)
        throw new Error(`Cannot verify Windows reparse status: ${error}`);
    } finally {
      close(event);
    }
  }

  return {
    user() {
      const buffer = Buffer.alloc(1024);
      const token: unknown[] = [null];
      if (!openToken(current(), 8, token))
        throw new Error("Cannot open process token");
      try {
        if (!tokenInfo(token[0], 1, buffer, buffer.length, [0]))
          throw new Error("Cannot read TokenUser");
        const sid: unknown = koffi.decode(buffer, "void *");
        if (!sid) throw new Error("TokenUser is missing a SID");
        return bytesFrom(sid, Number(sidSize(sid)), 68);
      } finally {
        buffer.fill(0);
        close(token[0]);
      }
    },
    read(path, directory) {
      const handle = openNoFollow(path);
      try {
        verifyKind(handle, directory);
        const descriptor: unknown[] = [null];
        try {
          const error = Number(
            getSecurity(handle, 1, 7, null, null, null, null, descriptor),
          );
          if (error !== 0 || !descriptor[0])
            throw new Error(
              `Cannot read Windows security descriptor: ${error}`,
            );
          return bytesFrom(
            descriptor[0],
            Number(descriptorSize(descriptor[0])),
            0x30000,
          );
        } finally {
          if (descriptor[0]) free(descriptor[0]);
        }
      } finally {
        close(handle);
      }
    },
  };
}

let native: Promise<WindowsSecurityReader> | undefined;

export function windowsSecurityReader(): Promise<WindowsSecurityReader> {
  return (native ??= openNative().catch((error: unknown) => {
    native = undefined;
    throw error;
  }));
}
