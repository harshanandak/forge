import { equal, match, ok } from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";

type Call = (...args: unknown[]) => unknown;
type Library = { func(signature: string): Call & { async: Call } };
type Koffi = {
  load(path: string): Library;
  decode(value: unknown, type: string, size?: number): unknown;
};

export const nativeName = "@koromix/koffi-win32-x64";
export const binaryName = "win32_x64/koffi.node";
export const [mode = "", target = ""] = process.argv.slice(2);
export const requireHub = createRequire(
  join(process.cwd(), "node_modules/forge-hub/package.json"),
);
export const systemDll = (name: string) =>
  join(process.env.SystemRoot ?? "C:/Windows", "System32", `${name}.dll`);
export function load(): Koffi {
  const entry = requireHub.resolve("koffi");
  const requireKoffi = createRequire(entry);
  for (const path of [entry, requireKoffi.resolve(nativeName)])
    match(relative(process.cwd(), path), /^node_modules[\\/]/i);
  return requireHub("koffi") as Koffi;
}

export function descriptor(
  path: string,
  advapi: Library,
  kernel: Library,
  koffi: Koffi,
): void {
  const get = advapi.func(
    "uint32_t GetNamedSecurityInfoW(str16 path, int type, uint32_t flags, void *owner, void *group, void *dacl, void *sacl, _Out_ void **descriptor)",
  );
  const pointer: unknown[] = [null];
  equal(get(path, 1, 5, null, null, null, null, pointer), 0);
  try {
    ok(pointer[0]);
    equal(koffi.decode(pointer[0], "uint8_t"), 1);
    const length = advapi.func(
      "uint32_t GetSecurityDescriptorLength(void *descriptor)",
    );
    ok(Number(length(pointer[0])) >= 20);
  } finally {
    equal(kernel.func("void *LocalFree(void *memory)")(pointer[0]), null);
  }
}

function tokenUser(advapi: Library, kernel: Library, koffi: Koffi): void {
  const current = kernel.func("void *GetCurrentProcess()");
  const open = advapi.func(
    "int OpenProcessToken(void *process, uint32_t access, _Out_ void **token)",
  );
  const info = advapi.func(
    "int GetTokenInformation(void *token, int kind, void *buffer, uint32_t size, _Out_ uint32_t *needed)",
  );
  const token: unknown[] = [null];
  ok(open(current(), 8, token));
  try {
    const bytes = Buffer.alloc(1024);
    ok(info(token[0], 1, bytes, bytes.length, [0]));
    const sid = koffi.decode(bytes, "void *");
    ok(sid);
    ok(advapi.func("int IsValidSid(void *sid)")(sid));
  } finally {
    ok(kernel.func("int CloseHandle(void *handle)")(token[0]));
  }
}

if (mode === "load" || mode === "cold") {
  const started = performance.now();
  const koffi = load();
  const kernel = koffi.load(systemDll("kernel32"));
  const advapi = koffi.load(systemDll("advapi32"));
  descriptor(target, advapi, kernel, koffi);
  if (mode === "load") {
    equal(kernel.func("uint32_t GetCurrentProcessId()")(), process.pid);
    tokenUser(advapi, kernel, koffi);
    const native = createRequire(requireHub.resolve("koffi")).resolve(
      nativeName,
    );
    ok(existsSync(join(dirname(native), binaryName)));
    console.log(
      JSON.stringify({ resolution: requireHub.resolve.paths("koffi"), native }),
    );
    if (typeof Bun === "undefined") {
      ok(globalThis.gc);
      globalThis.gc();
    } else Bun.gc(true);
    console.log(
      `load, Win32 calls and GC ${(performance.now() - started).toFixed(1)} ms`,
    );
  }
}
