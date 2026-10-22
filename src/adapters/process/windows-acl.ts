import { createRequire } from "node:module";
import type { PrivateFiles } from "../../ports/private-files.ts";

interface Library {
  func(declaration: string): (...args: unknown[]) => unknown;
}
interface Native {
  load(name: string): Library;
  decode(value: unknown, type: string, length?: number): unknown;
}

/** Reuse the process adapter's native Windows dependency; never launch a shell. */
export function windowsPrivateFiles(): PrivateFiles {
  const require = createRequire(import.meta.url);
  const native = require("koffi") as Native;
  const advapi = native.load("advapi32.dll");
  const kernel32 = native.load("kernel32.dll");
  const tokenOpen = advapi.func(
    "bool __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ void **token)",
  );
  const tokenInfo = advapi.func(
    "bool __stdcall GetTokenInformation(void *token, int kind, void *buffer, uint32_t size, _Out_ uint32_t *needed)",
  );
  const sidText = advapi.func(
    "bool __stdcall ConvertSidToStringSidW(void *sid, _Out_ void **text)",
  );
  const get = advapi.func(
    "bool __stdcall GetFileSecurityW(str16 path, uint32_t info, void *descriptor, uint32_t size, _Out_ uint32_t *needed)",
  );
  const toText = advapi.func(
    "bool __stdcall ConvertSecurityDescriptorToStringSecurityDescriptorW(void *descriptor, uint32_t revision, uint32_t info, _Out_ void **text, void *size)",
  );
  const fromText = advapi.func(
    "bool __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(str16 text, uint32_t revision, _Out_ void **descriptor, void *size)",
  );
  const set = advapi.func(
    "bool __stdcall SetFileSecurityW(str16 path, uint32_t info, void *descriptor)",
  );
  const free = kernel32.func("void * __stdcall LocalFree(void *memory)");
  const close = kernel32.func("bool __stdcall CloseHandle(void *handle)");
  const current = kernel32.func("void * __stdcall GetCurrentProcess()");
  const lastError = kernel32.func("uint32_t __stdcall GetLastError()");
  const check = (ok: unknown): void => {
    if (!ok)
      throw new Error(`Windows security API failed (${String(lastError())})`);
  };
  const takeText = (pointer: unknown): string => {
    try {
      const value = native.decode(pointer, "char16_t", -1);
      if (typeof value !== "string")
        throw new Error("Unreadable security descriptor");
      return value;
    } finally {
      free(pointer);
    }
  };
  const token: unknown[] = [null];
  check(tokenOpen(current(), 8, token));
  let sid: string;
  try {
    const bytes = Buffer.alloc(65536);
    check(tokenInfo(token[0], 1, bytes, bytes.length, [0]));
    const text: unknown[] = [null];
    check(sidText(native.decode(bytes, "void *"), text));
    sid = takeText(text[0]);
  } finally {
    close(token[0]);
  }
  return {
    sid,
    read(path) {
      const bytes = Buffer.alloc(65536);
      check(get(path, 4, bytes, bytes.length, [0]));
      const text: unknown[] = [null];
      check(toText(bytes, 1, 4, text, null));
      return takeText(text[0]);
    },
    protect(path, descriptor) {
      const pointer: unknown[] = [null];
      check(fromText(descriptor, 1, pointer, null));
      try {
        // A protected replacement only removes access; never reset to inherited defaults.
        check(set(path, 0x80000004, pointer[0]));
      } finally {
        free(pointer[0]);
      }
    },
  };
}
