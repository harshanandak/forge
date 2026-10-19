import { createRequire } from "node:module";
import { ProcessSpawnError } from "./errors.ts";

const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
const JOB_OBJECT_BASIC_PROCESS_ID_LIST = 3;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE = 0x0001;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_MORE_DATA = 234;
const MAX_ASSOCIATED_PROCESSES = 4096;
const MAX_CLEANUP_TIMEOUT_MS = 60_000;
const MAX_POLL_INTERVAL_MS = 1_000;

type NativeFunction<Arguments extends readonly unknown[], Result> = (
  ...args: Arguments
) => Result;

interface KoffiLibraryBoundary {
  func(...definition: readonly unknown[]): unknown;
}

interface KoffiBoundary {
  load(path: string): unknown;
  opaque(name?: string): unknown;
  pointer(...definition: readonly unknown[]): unknown;
  struct(name: string, members: Readonly<Record<string, unknown>>): unknown;
  out(type: unknown): unknown;
  sizeof(type: unknown): number;
}

interface NativeApi {
  readonly createJobObject: NativeFunction<readonly [null, null], unknown>;
  readonly setInformationJobObject: NativeFunction<
    readonly [bigint, number, Readonly<Record<string, unknown>>, number],
    number
  >;
  readonly openProcess: NativeFunction<
    readonly [number, number, number],
    unknown
  >;
  readonly assignProcessToJobObject: NativeFunction<
    readonly [bigint, bigint],
    number
  >;
  readonly queryInformationJobObject: NativeFunction<
    readonly [bigint, number, Buffer, number, null],
    number
  >;
  readonly terminateJobObject: NativeFunction<
    readonly [bigint, number],
    number
  >;
  readonly closeHandle: NativeFunction<readonly [bigint], number>;
  readonly getLastError: NativeFunction<readonly [], number>;
  readonly extendedLimitType: unknown;
  readonly extendedLimitSize: number;
}

export interface WindowsJob {
  attach(pid: number): void;
  stop(): Promise<readonly number[]>;
  close(): void;
}

export interface WindowsJobOptions {
  readonly cleanupTimeoutMs: number;
  readonly pollIntervalMs: number;
}

function hasFunction(value: unknown, key: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    key in value &&
    typeof value[key as keyof typeof value] === "function"
  );
}

function asKoffi(value: unknown): KoffiBoundary {
  if (
    !hasFunction(value, "load") ||
    !hasFunction(value, "opaque") ||
    !hasFunction(value, "pointer") ||
    !hasFunction(value, "struct") ||
    !hasFunction(value, "out") ||
    !hasFunction(value, "sizeof")
  ) {
    throw new TypeError("Koffi did not expose its expected synchronous API.");
  }
  return value as KoffiBoundary;
}

function asLibrary(value: unknown): KoffiLibraryBoundary {
  if (!hasFunction(value, "func")) {
    throw new TypeError("Koffi could not load kernel32.dll.");
  }
  return value as KoffiLibraryBoundary;
}

function asNativeFunction<Arguments extends readonly unknown[], Result>(
  value: unknown,
): NativeFunction<Arguments, Result> {
  if (typeof value !== "function") {
    throw new TypeError("Koffi could not bind a Windows API function.");
  }
  return value as NativeFunction<Arguments, Result>;
}

function loadNativeApi(): NativeApi {
  const require = createRequire(import.meta.url);
  const koffi = asKoffi(require("koffi") as unknown);
  const kernel32 = asLibrary(koffi.load("kernel32.dll"));
  const handleTarget = koffi.opaque("ForgeWindowsHandleTarget");
  const handle = koffi.pointer("ForgeWindowsHandle", handleTarget);
  const basicLimit = koffi.struct("ForgeJobBasicLimitInformation", {
    PerProcessUserTimeLimit: "int64_t",
    PerJobUserTimeLimit: "int64_t",
    LimitFlags: "uint32_t",
    MinimumWorkingSetSize: "uintptr_t",
    MaximumWorkingSetSize: "uintptr_t",
    ActiveProcessLimit: "uint32_t",
    Affinity: "uintptr_t",
    PriorityClass: "uint32_t",
    SchedulingClass: "uint32_t",
  });
  const ioCounters = koffi.struct("ForgeIoCounters", {
    ReadOperationCount: "uint64_t",
    WriteOperationCount: "uint64_t",
    OtherOperationCount: "uint64_t",
    ReadTransferCount: "uint64_t",
    WriteTransferCount: "uint64_t",
    OtherTransferCount: "uint64_t",
  });
  const extendedLimitType = koffi.struct(
    "ForgeJobExtendedLimitInformation",
    {
      BasicLimitInformation: basicLimit,
      IoInfo: ioCounters,
      ProcessMemoryLimit: "uintptr_t",
      JobMemoryLimit: "uintptr_t",
      PeakProcessMemoryUsed: "uintptr_t",
      PeakJobMemoryUsed: "uintptr_t",
    },
  );
  const byteOutput = koffi.out(koffi.pointer("uint8_t"));

  return {
    createJobObject: asNativeFunction(
      kernel32.func("__stdcall", "CreateJobObjectW", handle, [
        "void *",
        "void *",
      ]),
    ),
    setInformationJobObject: asNativeFunction(
      kernel32.func("__stdcall", "SetInformationJobObject", "int", [
        handle,
        "int",
        koffi.pointer(extendedLimitType),
        "uint32_t",
      ]),
    ),
    openProcess: asNativeFunction(
      kernel32.func("__stdcall", "OpenProcess", handle, [
        "uint32_t",
        "int",
        "uint32_t",
      ]),
    ),
    assignProcessToJobObject: asNativeFunction(
      kernel32.func("__stdcall", "AssignProcessToJobObject", "int", [
        handle,
        handle,
      ]),
    ),
    queryInformationJobObject: asNativeFunction(
      kernel32.func("__stdcall", "QueryInformationJobObject", "int", [
        handle,
        "int",
        byteOutput,
        "uint32_t",
        "void *",
      ]),
    ),
    terminateJobObject: asNativeFunction(
      kernel32.func("__stdcall", "TerminateJobObject", "int", [
        handle,
        "uint32_t",
      ]),
    ),
    closeHandle: asNativeFunction(
      kernel32.func("__stdcall", "CloseHandle", "int", [handle]),
    ),
    getLastError: asNativeFunction(
      kernel32.func("__stdcall", "GetLastError", "uint32_t", []),
    ),
    extendedLimitType,
    extendedLimitSize: koffi.sizeof(extendedLimitType),
  };
}

function isHandle(value: unknown): value is bigint {
  return typeof value === "bigint" && value !== 0n;
}

function nativeError(api: NativeApi, operation: string): Error {
  return new Error(`${operation} failed with Windows error ${api.getLastError()}.`);
}

function emptyExtendedLimits(): Readonly<Record<string, unknown>> {
  return {
    BasicLimitInformation: {
      PerProcessUserTimeLimit: 0,
      PerJobUserTimeLimit: 0,
      LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
      MinimumWorkingSetSize: 0,
      MaximumWorkingSetSize: 0,
      ActiveProcessLimit: 0,
      Affinity: 0,
      PriorityClass: 0,
      SchedulingClass: 0,
    },
    IoInfo: {
      ReadOperationCount: 0,
      WriteOperationCount: 0,
      OtherOperationCount: 0,
      ReadTransferCount: 0,
      WriteTransferCount: 0,
      OtherTransferCount: 0,
    },
    ProcessMemoryLimit: 0,
    JobMemoryLimit: 0,
    PeakProcessMemoryUsed: 0,
    PeakJobMemoryUsed: 0,
  };
}

function processIds(api: NativeApi, job: bigint): readonly number[] {
  const pointerBytes = process.arch === "ia32" ? 4 : 8;
  let capacity = 16;
  while (capacity <= MAX_ASSOCIATED_PROCESSES) {
    const buffer = Buffer.alloc(8 + capacity * pointerBytes);
    const succeeded = api.queryInformationJobObject(
      job,
      JOB_OBJECT_BASIC_PROCESS_ID_LIST,
      buffer,
      buffer.length,
      null,
    );
    const assigned = buffer.readUInt32LE(0);
    const listed = buffer.readUInt32LE(4);
    if (succeeded !== 0 && listed >= assigned) {
      const result: number[] = [];
      for (let index = 0; index < listed; index += 1) {
        const offset = 8 + index * pointerBytes;
        const pid =
          pointerBytes === 4
            ? buffer.readUInt32LE(offset)
            : Number(buffer.readBigUInt64LE(offset));
        if (Number.isSafeInteger(pid) && pid > 0) result.push(pid);
      }
      return result;
    }

    const error = succeeded === 0 ? api.getLastError() : ERROR_MORE_DATA;
    if (error !== ERROR_MORE_DATA && error !== ERROR_INSUFFICIENT_BUFFER) {
      throw new ProcessSpawnError(
        "TREE_KILL_FAILED",
        "Could not snapshot the contained process tree.",
        new Error(`QueryInformationJobObject failed with Windows error ${error}.`),
      );
    }
    const needed = Math.max(capacity + 1, assigned);
    if (needed > MAX_ASSOCIATED_PROCESSES) break;
    capacity = Math.min(
      MAX_ASSOCIATED_PROCESSES,
      Math.max(capacity * 2, needed),
    );
  }
  throw new ProcessSpawnError(
    "TREE_KILL_FAILED",
    `The contained process tree exceeds ${MAX_ASSOCIATED_PROCESSES} processes.`,
  );
}

function activeProcesses(api: NativeApi, job: bigint): number {
  const accounting = Buffer.alloc(48);
  if (
    api.queryInformationJobObject(
      job,
      1,
      accounting,
      accounting.length,
      null,
    ) === 0
  ) {
    throw new ProcessSpawnError(
      "TREE_KILL_FAILED",
      "Could not confirm that the contained process tree stopped.",
      nativeError(api, "QueryInformationJobObject"),
    );
  }
  return accounting.readUInt32LE(36);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Opens an unnamed Windows Job Object that owns every attached process and descendant. */
export function openWindowsJob(options: WindowsJobOptions): WindowsJob {
  if (process.platform !== "win32") {
    throw new ProcessSpawnError(
      "CONTAINMENT_UNAVAILABLE",
      "Windows Job Objects are unavailable on this platform.",
    );
  }
  if (
    !Number.isInteger(options.cleanupTimeoutMs) ||
    options.cleanupTimeoutMs <= 0 ||
    options.cleanupTimeoutMs > MAX_CLEANUP_TIMEOUT_MS ||
    !Number.isInteger(options.pollIntervalMs) ||
    options.pollIntervalMs <= 0 ||
    options.pollIntervalMs > MAX_POLL_INTERVAL_MS ||
    options.pollIntervalMs > options.cleanupTimeoutMs
  ) {
    throw new ProcessSpawnError(
      "INVALID_OPTIONS",
      "Windows containment cleanup requires a timeout from 1 to 60000 ms and a poll interval from 1 to 1000 ms that does not exceed the timeout.",
    );
  }

  let api: NativeApi;
  try {
    api = loadNativeApi();
  } catch (cause) {
    throw new ProcessSpawnError(
      "CONTAINMENT_UNAVAILABLE",
      "Windows Job Object support could not be loaded.",
      cause,
    );
  }

  const created = api.createJobObject(null, null);
  if (!isHandle(created)) {
    throw new ProcessSpawnError(
      "CONTAINMENT_UNAVAILABLE",
      "Could not create a Windows Job Object.",
      nativeError(api, "CreateJobObjectW"),
    );
  }

  let job: bigint | undefined = created;
  if (
    api.setInformationJobObject(
      job,
      JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
      emptyExtendedLimits(),
      api.extendedLimitSize,
    ) === 0
  ) {
    const cause = nativeError(api, "SetInformationJobObject");
    api.closeHandle(job);
    job = undefined;
    throw new ProcessSpawnError(
      "CONTAINMENT_UNAVAILABLE",
      "Could not enforce Windows process containment.",
      cause,
    );
  }

  let stopping: Promise<readonly number[]> | undefined;
  const currentJob = (): bigint => {
    if (job === undefined) {
      throw new ProcessSpawnError(
        "CONTAINMENT_UNAVAILABLE",
        "The Windows Job Object is closed.",
      );
    }
    return job;
  };

  return {
    attach(pid: number): void {
      if (!Number.isInteger(pid) || pid <= 0 || pid > 0xffffffff) {
        throw new ProcessSpawnError(
          "CONTAINMENT_UNAVAILABLE",
          "A valid process identifier is required for Windows containment.",
        );
      }
      const processHandle = api.openProcess(
        PROCESS_SET_QUOTA | PROCESS_TERMINATE,
        0,
        pid,
      );
      if (!isHandle(processHandle)) {
        throw new ProcessSpawnError(
          "CONTAINMENT_UNAVAILABLE",
          `Could not open process ${pid} for Windows containment.`,
          nativeError(api, "OpenProcess"),
        );
      }
      try {
        if (api.assignProcessToJobObject(currentJob(), processHandle) === 0) {
          throw new ProcessSpawnError(
            "CONTAINMENT_UNAVAILABLE",
            `Could not contain process ${pid} in a Windows Job Object.`,
            nativeError(api, "AssignProcessToJobObject"),
          );
        }
      } finally {
        api.closeHandle(processHandle);
      }
    },

    stop(): Promise<readonly number[]> {
      if (stopping !== undefined) return stopping;
      const handle = currentJob();
      stopping = (async (): Promise<readonly number[]> => {
        let stopped: readonly number[];
        try {
          stopped = processIds(api, handle);
        } catch (cause) {
          api.terminateJobObject(handle, 1);
          throw cause;
        }
        if (api.terminateJobObject(handle, 1) === 0) {
          throw new ProcessSpawnError(
            "TREE_KILL_FAILED",
            "Could not stop the contained process tree.",
            nativeError(api, "TerminateJobObject"),
          );
        }
        const deadline = performance.now() + options.cleanupTimeoutMs;
        while (activeProcesses(api, handle) !== 0) {
          const remaining = deadline - performance.now();
          if (remaining <= 0) {
            throw new ProcessSpawnError(
              "TREE_KILL_FAILED",
              `The contained process tree did not stop within ${options.cleanupTimeoutMs} ms.`,
            );
          }
          await delay(Math.min(options.pollIntervalMs, remaining));
        }
        return stopped;
      })();
      return stopping;
    },

    close(): void {
      if (job === undefined) return;
      const handle = job;
      job = undefined;
      if (api.closeHandle(handle) === 0) {
        throw new ProcessSpawnError(
          "TREE_KILL_FAILED",
          "Could not release the Windows Job Object.",
          nativeError(api, "CloseHandle"),
        );
      }
    },
  };
}
