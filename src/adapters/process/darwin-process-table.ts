import { createRequire } from "node:module";
import type { ProcessTablePort } from "./linux-process-table.ts";

const PROC_PIDT_SHORTBSDINFO = 13;
const SHORT_BSD_INFO_BYTES = 64;
const DARWIN_ESRCH = 3;
// A hard allocation ceiling, matching the Windows job inventory cap. A full
// buffer is ambiguous because libproc silently truncates, so it fails closed.
export const MAX_DARWIN_GROUP_MEMBERS = 4096;

export interface DarwinProcessApi {
  listGroup(groupId: number, buffer: Buffer, bytes: number): number;
  pidInfo(
    pid: number,
    flavor: number,
    argument: number,
    buffer: Buffer,
    bytes: number,
  ): number;
  errno(value?: number): number;
}

interface NativeLibrary {
  func(definition: string): unknown;
}

interface NativeBindings {
  load(path: string): unknown;
  errno(value?: number): number;
}

function hasFunction(value: unknown, key: string): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    key in value &&
    typeof value[key as keyof typeof value] === "function"
  );
}

function nativeFunction<Arguments extends readonly unknown[], Result>(
  value: unknown,
): (...args: Arguments) => Result {
  if (typeof value !== "function")
    throw new TypeError("Could not bind Darwin process API");
  return value as (...args: Arguments) => Result;
}

let loadedApi: DarwinProcessApi | undefined;
function loadNativeApi(): DarwinProcessApi {
  if (loadedApi !== undefined) return loadedApi;
  const require = createRequire(import.meta.url);
  const boundary: unknown = require("koffi");
  if (!hasFunction(boundary, "load") || !hasFunction(boundary, "errno"))
    throw new TypeError("Koffi did not expose its expected synchronous API");
  const bindings = boundary as NativeBindings;
  const libraryBoundary = bindings.load("/usr/lib/libproc.dylib");
  if (!hasFunction(libraryBoundary, "func"))
    throw new TypeError("Could not load Darwin process API");
  const library = libraryBoundary as NativeLibrary;
  loadedApi = {
    listGroup: nativeFunction(
      library.func(
        "int proc_listpgrppids(int pgrpid, void *buffer, int buffersize)",
      ),
    ),
    pidInfo: nativeFunction(
      library.func(
        "int proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int buffersize)",
      ),
    ),
    errno: (value) =>
      value === undefined ? bindings.errno() : bindings.errno(value),
  };
  return loadedApi;
}

export function createDarwinProcessTable(
  load: () => DarwinProcessApi = loadNativeApi,
): ProcessTablePort {
  return {
    *members(groupId, checkBudget) {
      checkBudget();
      if (!Number.isInteger(groupId) || groupId <= 0 || groupId > 0x7fffffff)
        throw new TypeError("Invalid Darwin process group identity");
      const api = load();
      const pids = Buffer.alloc(MAX_DARWIN_GROUP_MEMBERS * 4);
      api.errno(0);
      // libproc returns a PID count, unlike proc_listpids which returns bytes.
      const count = api.listGroup(groupId, pids, pids.length);
      const error = api.errno();
      checkBudget();
      if (
        !Number.isInteger(count) ||
        count < 0 ||
        count >= MAX_DARWIN_GROUP_MEMBERS ||
        (count === 0 && error !== 0)
      )
        throw new Error("Could not enumerate Darwin process group");
      const record = Buffer.alloc(SHORT_BSD_INFO_BYTES);
      for (let index = 0; index < count; index++) {
        checkBudget();
        const pid = pids.readInt32LE(index * 4);
        if (pid <= 0) throw new Error("Invalid Darwin process identity");
        api.errno(0);
        // Live-only lookup reports retained zombies as ESRCH. Including them can
        // enter XNU's unbounded zombie-reference wait during concurrent reaping.
        const bytes = api.pidInfo(
          pid,
          PROC_PIDT_SHORTBSDINFO,
          0,
          record,
          record.length,
        );
        const infoError = api.errno();
        checkBudget();
        if (bytes === 0) {
          if (infoError === DARWIN_ESRCH) continue;
          throw new Error("Could not inspect Darwin process");
        }
        if (bytes !== SHORT_BSD_INFO_BYTES)
          throw new Error("Invalid Darwin process record size");
        // proc_bsdshortinfo begins with four fixed-width uint32_t fields:
        // pid, ppid, pgid, status. Its public layout is identical on arm64/x64.
        if (record.readUInt32LE(0) !== pid)
          throw new Error("Invalid Darwin process identity");
        if (record.readUInt32LE(8) !== groupId) continue;
        const status = record.readUInt32LE(12);
        const state = ["", "I", "R", "S", "T", "Z"][status];
        if (state === undefined || state === "")
          throw new Error("Invalid Darwin process state");
        yield { pid, state };
      }
    },
  };
}

export const darwinProcessTable: ProcessTablePort = createDarwinProcessTable();
