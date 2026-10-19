import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Test measurement only: native counters avoid shell startup and WMI on loaded runners.
// https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-process_memory_counters
// https://learn.microsoft.com/en-us/windows/win32/api/tlhelp32/ns-tlhelp32-threadentry32
export function windowsFootprint() {
  assert.ok(["x64", "arm64"].includes(process.arch));
  const koffi = createRequire(import.meta.url)("koffi");
  const api = koffi.load("kernel32.dll");
  const bind = (name, result, args) =>
    api.func("__stdcall", name, result, args);
  const open = bind("OpenProcess", "uintptr_t", [
    "uint32_t",
    "int",
    "uint32_t",
  ]);
  const close = bind("CloseHandle", "int", ["uintptr_t"]);
  const memory = bind("K32GetProcessMemoryInfo", "int", [
    "uintptr_t",
    "void *",
    "uint32_t",
  ]);
  const snapshot = bind("CreateToolhelp32Snapshot", "uintptr_t", [
    "uint32_t",
    "uint32_t",
  ]);
  const first = bind("Thread32First", "int", ["uintptr_t", "void *"]);
  const next = bind("Thread32Next", "int", ["uintptr_t", "void *"]);
  const lastError = bind("GetLastError", "uint32_t", []);
  return (host, helpers) => {
    const pids = [host, ...helpers];
    const counts = new Map(pids.map((pid) => [pid, 0]));
    const handle = snapshot(4, 0);
    assert.notEqual(handle, 0);
    assert.notEqual(
      BigInt(handle),
      0xffffffffffffffffn,
      "thread snapshot failed",
    );
    try {
      const entry = Buffer.alloc(28);
      entry.writeUInt32LE(entry.length);
      let present = first(handle, entry);
      let scanned = 0;
      while (present !== 0) {
        assert.ok(
          ++scanned <= 65536,
          "thread snapshot exceeded its inspection bound",
        );
        assert.ok(entry.readUInt32LE(0) >= 16, "thread owner field missing");
        const owner = entry.readUInt32LE(12);
        if (counts.has(owner)) counts.set(owner, counts.get(owner) + 1);
        entry.writeUInt32LE(entry.length);
        present = next(handle, entry);
      }
      assert.equal(lastError(), 18, "thread snapshot did not reach its end");
    } finally {
      assert.notEqual(close(handle), 0, "thread snapshot handle did not close");
    }
    const measurements = pids.map((pid) => {
      const processHandle = open(0x410, 0, pid);
      assert.notEqual(processHandle, 0, "owned process could not be measured");
      try {
        const counters = Buffer.alloc(80);
        counters.writeUInt32LE(counters.length);
        assert.notEqual(
          memory(processHandle, counters, counters.length),
          0,
          "working set measurement failed",
        );
        const threads = counts.get(pid);
        assert.ok(threads > 0, "owned process thread count missing");
        return {
          pid,
          residentBytes: Number(counters.readBigUInt64LE(16)),
          threads,
        };
      } finally {
        assert.notEqual(
          close(processHandle),
          0,
          "process measurement handle did not close",
        );
      }
    });
    return {
      hostResidentBytes: measurements[0].residentBytes,
      hostThreads: measurements[0].threads,
      helpers: measurements.slice(1),
    };
  };
}
