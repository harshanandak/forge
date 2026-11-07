import { win32 } from "node:path";
import { envValue } from "./env.ts";
import { ProcessSpawnError } from "./errors.ts";
import type { SpawnPlan } from "./plan.ts";
import {
  asNativeFunction,
  windowsJobHandle,
  windowsNativeFoundation,
  type KoffiBoundary,
  type WindowsJob,
} from "./windows-job.ts";

// Starts a command inside a per-command Job Object in one CreateProcessW call, so no helper
// process is needed and the command has no moment outside the job.
const PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;
const PROC_THREAD_ATTRIBUTE_JOB_LIST = 0x0002000d;
const EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
const CREATE_UNICODE_ENVIRONMENT = 0x00000400;
const CREATE_NO_WINDOW = 0x08000000;
const STARTF_USESHOWWINDOW = 0x00000001;
const STARTF_USESTDHANDLES = 0x00000100;
const SW_HIDE = 0;
const SW_SHOWDEFAULT = 10;
const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const FILE_SHARE_READ_WRITE = 0x00000003;
const OPEN_EXISTING = 3;
const FILE_ATTRIBUTE_NORMAL = 0x00000080;
const ERROR_INSUFFICIENT_BUFFER = 122;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 258;
/**
 * What libuv's `uv_translate_sys_error` reports for the errors CreateProcessW returns, so a failed
 * start carries the same errno name as Node's spawn gives today (access denied is EPERM there).
 */
const ERRNO_FOR_WINDOWS_ERROR: Readonly<Record<number, string>> = {
  2: "ENOENT",
  3: "ENOENT",
  15: "ENOENT",
  53: "ENOENT",
  123: "ENOENT",
  161: "ENOENT",
  267: "ENOENT",
  5: "EPERM",
  740: "EACCES",
  998: "EACCES",
  1920: "EACCES",
  8: "ENOMEM",
  14: "ENOMEM",
  87: "EINVAL",
  206: "ENAMETOOLONG",
};
const MAX_COMMAND_LINE_UNITS = 32766;
/** libuv copies these from the parent when the caller's environment lacks them (process.c). */
const LIBUV_REQUIRED_VARIABLES = [
  "HOMEDRIVE",
  "HOMEPATH",
  "LOGONSERVER",
  "PATH",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
];

export interface LaunchOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** Defaults to true, like `windowsHide: true` in the helper. */
  readonly windowsHide?: boolean;
  /**
   * Names of named pipes the host is already listening on. The launcher opens the client ends and
   * hands them to the command; any stream left out stays on the NUL device.
   */
  readonly pipes?: {
    readonly stdin?: string;
    readonly stdout?: string;
    readonly stderr?: string;
  };
}

export interface LaunchedProcess {
  readonly pid: number;
  /** The caller owns this handle and must close it with `closeLaunchedProcess`. */
  readonly processHandle: bigint;
}

type Pointer = bigint | null;

interface LaunchApi {
  readonly initializeAttributeList: (
    list: Pointer,
    count: number,
    flags: number,
    size: bigint,
  ) => number;
  readonly updateAttribute: (
    list: bigint,
    flags: number,
    attribute: number,
    value: bigint,
    size: number,
    previous: null,
    returned: null,
  ) => number;
  readonly deleteAttributeList: (list: bigint) => void;
  readonly createFile: (
    name: string,
    access: number,
    share: number,
    security: Readonly<Record<string, unknown>>,
    disposition: number,
    attributes: number,
    template: null,
  ) => unknown;
  readonly createProcess: (
    application: string,
    commandLine: Buffer,
    processSecurity: null,
    threadSecurity: null,
    inherit: number,
    flags: number,
    environment: Buffer,
    cwd: string,
    startup: Readonly<Record<string, unknown>>,
    information: Record<string, unknown>,
  ) => number;
  readonly koffi: KoffiBoundary;
  readonly startupSize: number;
  readonly securitySize: number;
  readonly pointerBytes: number;
  readonly waitForSingleObject: (
    handle: bigint,
    milliseconds: number,
  ) => number;
  readonly getExitCodeProcess: (handle: bigint, code: Buffer) => number;
  readonly closeHandle: (handle: bigint) => number;
  readonly lastError: () => number;
}

let launchApi: LaunchApi | undefined;

function loadLaunchApi(): LaunchApi {
  if (launchApi !== undefined) return launchApi;
  const { koffi, kernel32, closeHandle, lastError } = windowsNativeFoundation();
  const security = koffi.struct("ForgeSecurityAttributes", {
    nLength: "uint32_t",
    lpSecurityDescriptor: "void *",
    bInheritHandle: "int",
  });
  const startupInfo = koffi.struct("ForgeStartupInfoExW", {
    cb: "uint32_t",
    lpReserved: "void *",
    lpDesktop: "void *",
    lpTitle: "void *",
    dwX: "uint32_t",
    dwY: "uint32_t",
    dwXSize: "uint32_t",
    dwYSize: "uint32_t",
    dwXCountChars: "uint32_t",
    dwYCountChars: "uint32_t",
    dwFillAttribute: "uint32_t",
    dwFlags: "uint32_t",
    wShowWindow: "uint16_t",
    cbReserved2: "uint16_t",
    lpReserved2: "void *",
    hStdInput: "void *",
    hStdOutput: "void *",
    hStdError: "void *",
    lpAttributeList: "void *",
  });
  const processInformation = koffi.struct("ForgeProcessInformation", {
    hProcess: "void *",
    hThread: "void *",
    dwProcessId: "uint32_t",
    dwThreadId: "uint32_t",
  });
  launchApi = {
    initializeAttributeList: asNativeFunction(
      kernel32.func("__stdcall", "InitializeProcThreadAttributeList", "int", [
        "void *",
        "uint32_t",
        "uint32_t",
        "void *",
      ]),
    ),
    updateAttribute: asNativeFunction(
      kernel32.func("__stdcall", "UpdateProcThreadAttribute", "int", [
        "void *",
        "uint32_t",
        "uintptr_t",
        "void *",
        "uintptr_t",
        "void *",
        "void *",
      ]),
    ),
    deleteAttributeList: asNativeFunction(
      kernel32.func("__stdcall", "DeleteProcThreadAttributeList", "void", [
        "void *",
      ]),
    ),
    createFile: asNativeFunction(
      kernel32.func("__stdcall", "CreateFileW", "void *", [
        "str16",
        "uint32_t",
        "uint32_t",
        koffi.pointer(security),
        "uint32_t",
        "uint32_t",
        "void *",
      ]),
    ),
    createProcess: asNativeFunction(
      kernel32.func("__stdcall", "CreateProcessW", "int", [
        "str16",
        "void *",
        "void *",
        "void *",
        "int",
        "uint32_t",
        "void *",
        "str16",
        koffi.pointer(startupInfo),
        koffi.out(koffi.pointer(processInformation)),
      ]),
    ),
    waitForSingleObject: asNativeFunction(
      kernel32.func("__stdcall", "WaitForSingleObject", "uint32_t", [
        "void *",
        "uint32_t",
      ]),
    ),
    getExitCodeProcess: asNativeFunction(
      kernel32.func("__stdcall", "GetExitCodeProcess", "int", [
        "void *",
        koffi.out(koffi.pointer("uint8_t")),
      ]),
    ),
    koffi,
    startupSize: koffi.sizeof(startupInfo),
    securitySize: koffi.sizeof(security),
    pointerBytes: koffi.sizeof("void *"),
    closeHandle,
    lastError,
  };
  return launchApi;
}

function refuse(message: string): never {
  throw new ProcessSpawnError("INVALID_OPTIONS", message);
}

function isHandle(value: unknown, pointerBytes: number): value is bigint {
  return (
    typeof value === "bigint" &&
    value > 0n &&
    value !== (1n << BigInt(pointerBytes * 8)) - 1n
  );
}

/** Same quoting as libuv `quote_cmd_arg`, so the child parses the argument it was given. */
export function quoteWindowsArgument(source: string): string {
  if (source.length === 0) return '""';
  if (!/[ \t"]/.test(source)) return source;
  if (!/["\\]/.test(source)) return `"${source}"`;
  let reversed = "";
  let quoteHit = true;
  for (let index = source.length; index > 0; index -= 1) {
    const unit = source.charAt(index - 1);
    reversed += unit;
    if (quoteHit && unit === "\\") reversed += "\\";
    else if (unit === '"') {
      quoteHit = true;
      reversed += "\\";
    } else quoteHit = false;
  }
  return `"${reversed.split("").reverse().join("")}"`;
}

/** libuv `make_program_args`: quote each argument, or copy verbatim for the cmd.exe plan. */
export function buildWindowsCommandLine(plan: SpawnPlan): string {
  const parts = [plan.file, ...plan.args].map((part) => part.toWellFormed());
  return plan.windowsVerbatimArguments
    ? parts.join(" ")
    : parts.map(quoteWindowsArgument).join(" ");
}

function upperName(name: string): string {
  return Array.from(name, (unit) => {
    const upper = unit.toUpperCase();
    return upper.length === unit.length ? upper : unit;
  }).join("");
}

/**
 * libuv `make_program_env`: only entries with `=`, sorted by case-insensitive name, plus the
 * required variables above copied from the parent when missing. UTF-16, NUL separated, ending
 * with an extra NUL.
 */
export function buildWindowsEnvironmentBlock(
  env: Readonly<Record<string, string>>,
  parent: Readonly<Record<string, string | undefined>> = process.env,
): Buffer {
  const entries = new Map<string, string>();
  // Node (lib/child_process.js, win32): sort the keys, then keep only the first of each
  // case-insensitive name, so { Path, PATH } passes PATH alone.
  const sawName = new Set<string>();
  for (const name of Object.keys(env).sort()) {
    const folded = name.toUpperCase();
    if (sawName.has(folded)) continue;
    sawName.add(folded);
    const value = env[name] as string;
    if (name === "" || name.includes("=") || name.includes("\0"))
      refuse(
        "An environment name must not be empty or hold an equals sign or a NUL.",
      );
    if (value.includes("\0")) refuse("An environment value holds a NUL.");
    entries.set(`${name}=${value}`.toWellFormed(), upperName(name));
  }
  const present = new Set(entries.values());
  for (const name of LIBUV_REQUIRED_VARIABLES) {
    if (present.has(name)) continue;
    const key = Object.keys(parent).find((k) => upperName(k) === name);
    const value = key === undefined ? undefined : parent[key];
    if (value !== undefined) {
      entries.set(`${name}=${value}`.toWellFormed(), name);
    }
  }
  const sorted = [...entries].sort(([, a], [, b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const text = sorted.map(([entry]) => `${entry}\0`).join("");
  // Windows wants two NULs even for an empty block.
  return Buffer.from(`${text}\0${sorted.length === 0 ? "\0" : ""}`, "utf16le");
}

const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/])/;

/**
 * `lpApplicationName` must be absolute or CreateProcessW searches the working directory. The one
 * bare name the plan can produce, the cmd.exe fallback, is resolved from SystemRoot, never searched.
 */
function absoluteApplication(
  file: string,
  env: Readonly<Record<string, string>>,
): string {
  if (file.includes("\0")) refuse("The program path holds a NUL.");
  let resolved = file;
  if (file.toLowerCase() === "cmd.exe") {
    const root = envValue(env, "SystemRoot", "win32");
    if (root !== undefined && ABSOLUTE.test(root))
      resolved = win32.join(root, "System32", "cmd.exe");
  }
  if (!ABSOLUTE.test(resolved))
    refuse(
      `Refusing to launch "${file}": the program path must be absolute so Windows never searches the working directory.`,
    );
  return resolved;
}

/** Opens the NUL device or a pipe client end as an inheritable handle for a standard stream. */
function openStdio(api: LaunchApi, name: string, write: boolean): bigint {
  const handle = api.createFile(
    name,
    write ? GENERIC_WRITE : GENERIC_READ,
    FILE_SHARE_READ_WRITE,
    {
      nLength: api.securitySize,
      lpSecurityDescriptor: null,
      bInheritHandle: 1,
    },
    OPEN_EXISTING,
    FILE_ATTRIBUTE_NORMAL,
    null,
  );
  if (!isHandle(handle, api.pointerBytes))
    throw new ProcessSpawnError(
      "SPAWN_FAILED",
      `Could not open ${name === "NUL" ? "the NUL device" : "a pipe"} for the command's standard handles.`,
      new Error(`CreateFileW failed with Windows error ${api.lastError()}.`),
    );
  return handle;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** SPAWN_FAILED carrying the errno name Node's spawn would report for this Windows error. */
function startFailure(error: number): ProcessSpawnError {
  const code = ERRNO_FOR_WINDOWS_ERROR[error];
  const message = `CreateProcessW failed with Windows error ${error}.`;
  return new ProcessSpawnError(
    "SPAWN_FAILED",
    "Could not start the command.",
    code === undefined
      ? new Error(message)
      : Object.assign(new Error(message), { code }),
  );
}

/** Ends every process in the per-command job, so a launch that cannot be returned runs nowhere. */
function endJob(job: WindowsJob): void {
  void job.stop().catch(() => undefined);
}

/** Runs every release step even when one throws, and returns the first error. */
function releaseLaunch(
  api: LaunchApi,
  attributeList: bigint | undefined,
  allocations: readonly bigint[],
  handles: readonly bigint[],
): Error | undefined {
  const errors: Error[] = [];
  const step = (action: () => void): void => {
    try {
      action();
    } catch (error) {
      errors.push(asError(error));
    }
  };
  if (attributeList !== undefined)
    step(() => api.deleteAttributeList(attributeList));
  for (const pointer of allocations) step(() => api.koffi.free(pointer));
  for (const handle of handles) step(() => api.closeHandle(handle));
  return errors[0];
}

/**
 * Starts `plan` directly inside `job`. Its standard handles are the pipe client ends in
 * `options.pipes`, or the NUL device. Only those three handles are inherited; the job handle never
 * is, and the launcher closes its own copies before it returns.
 */
export function launchInJob(
  plan: SpawnPlan,
  job: WindowsJob,
  options: LaunchOptions,
): LaunchedProcess {
  if (process.platform !== "win32")
    throw new ProcessSpawnError(
      "CONTAINMENT_UNAVAILABLE",
      "The Windows launcher is unavailable on this platform.",
    );
  const application = absoluteApplication(plan.file, options.env);
  const commandLine = buildWindowsCommandLine(plan);
  if (commandLine.includes("\0")) refuse("The command line holds a NUL.");
  if (commandLine.length > MAX_COMMAND_LINE_UNITS)
    throw new ProcessSpawnError(
      "SPAWN_FAILED",
      "The command line is too long for Windows.",
      Object.assign(new Error("Command line exceeds 32766 characters."), {
        code: "E2BIG",
      }),
    );
  if (options.cwd.includes("\0")) refuse("The working directory holds a NUL.");
  const environment = buildWindowsEnvironmentBlock(options.env);
  const jobHandle = windowsJobHandle(job);
  let api: LaunchApi;
  try {
    api = loadLaunchApi();
  } catch (cause) {
    throw new ProcessSpawnError(
      "CONTAINMENT_UNAVAILABLE",
      "The Windows launcher could not be loaded.",
      cause,
    );
  }
  const { koffi } = api;
  const size = api.pointerBytes;
  const stdioHandles: bigint[] = [];
  const allocations: bigint[] = [];
  let attributeList: bigint | undefined;
  let launched: LaunchedProcess | undefined;
  let failure: Error | undefined;
  try {
    const pipes = options.pipes;
    const targets = [pipes?.stdin, pipes?.stdout, pipes?.stderr];
    for (const [index, name] of targets.entries())
      stdioHandles.push(openStdio(api, name ?? "NUL", index !== 0));
    const sizeSlot = koffi.alloc("uintptr_t", 1);
    allocations.push(sizeSlot);
    // The first call fails by design and reports the buffer size the list needs.
    api.initializeAttributeList(null, 2, 0, sizeSlot);
    const needed = Number(koffi.decode(sizeSlot, "uintptr_t"));
    if (!Number.isSafeInteger(needed) || needed <= 0)
      throw new ProcessSpawnError(
        "SPAWN_FAILED",
        "Could not size the process attribute list.",
        new Error(
          `InitializeProcThreadAttributeList failed with Windows error ${api.lastError()} (expected ${ERROR_INSUFFICIENT_BUFFER}).`,
        ),
      );
    const list = koffi.alloc("uint8_t", needed);
    allocations.push(list);
    if (api.initializeAttributeList(list, 2, 0, sizeSlot) === 0)
      throw new ProcessSpawnError(
        "SPAWN_FAILED",
        "Could not initialize the process attribute list.",
        new Error(
          `InitializeProcThreadAttributeList failed with Windows error ${api.lastError()}.`,
        ),
      );
    attributeList = list;
    // The list keeps pointers to these values, so they stay allocated until after the launch.
    const jobSlot = koffi.alloc("void *", 1);
    allocations.push(jobSlot);
    const handleSlots = koffi.alloc("void *", stdioHandles.length);
    allocations.push(handleSlots);
    koffi.encode(jobSlot, 0, "void *", jobHandle);
    stdioHandles.forEach((handle, index) =>
      koffi.encode(handleSlots, index * size, "void *", handle),
    );
    for (const [attribute, value, bytes] of [
      [PROC_THREAD_ATTRIBUTE_JOB_LIST, jobSlot, size],
      [
        PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        handleSlots,
        size * stdioHandles.length,
      ],
    ] as const) {
      if (
        api.updateAttribute(list, 0, attribute, value, bytes, null, null) === 0
      )
        throw new ProcessSpawnError(
          "SPAWN_FAILED",
          "Could not set a process attribute.",
          new Error(
            `UpdateProcThreadAttribute failed with Windows error ${api.lastError()}.`,
          ),
        );
    }
    const hide = options.windowsHide !== false;
    const [stdin, stdout, stderr] = stdioHandles;
    const startup = {
      cb: api.startupSize,
      lpReserved: null,
      lpDesktop: null,
      lpTitle: null,
      dwX: 0,
      dwY: 0,
      dwXSize: 0,
      dwYSize: 0,
      dwXCountChars: 0,
      dwYCountChars: 0,
      dwFillAttribute: 0,
      dwFlags: STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW,
      wShowWindow: hide ? SW_HIDE : SW_SHOWDEFAULT,
      cbReserved2: 0,
      lpReserved2: null,
      hStdInput: stdin ?? null,
      hStdOutput: stdout ?? null,
      hStdError: stderr ?? null,
      lpAttributeList: list,
    };
    const information: Record<string, unknown> = {};
    const created = api.createProcess(
      application,
      Buffer.from(`${commandLine}\0`, "utf16le"),
      null,
      null,
      1,
      EXTENDED_STARTUPINFO_PRESENT |
        CREATE_UNICODE_ENVIRONMENT |
        (hide ? CREATE_NO_WINDOW : 0),
      environment,
      win32.resolve(options.cwd),
      startup,
      information,
    );
    if (created === 0) throw startFailure(api.lastError());
    const { hProcess, hThread, dwProcessId } = information;
    if (isHandle(hThread, size)) api.closeHandle(hThread);
    if (isHandle(hProcess, size) && typeof dwProcessId === "number") {
      launched = { pid: dwProcessId, processHandle: hProcess };
    } else {
      // The command is already running in the job; end it rather than leave it unowned.
      if (isHandle(hProcess, size)) api.closeHandle(hProcess);
      endJob(job);
      throw new ProcessSpawnError(
        "SPAWN_FAILED",
        "Windows returned no process handle for the command.",
      );
    }
  } catch (error) {
    failure = asError(error);
  }
  const cleanupError = releaseLaunch(
    api,
    attributeList,
    allocations,
    stdioHandles,
  );
  // A failed launch reports its own error; a cleanup error never hides it.
  if (failure !== undefined) throw failure;
  if (launched === undefined)
    throw new ProcessSpawnError("SPAWN_FAILED", "The command did not start.");
  if (cleanupError !== undefined) {
    // Cleanup failed after a good launch: hand back nothing that could leak or run unowned.
    api.closeHandle(launched.processHandle);
    endJob(job);
    throw cleanupError;
  }
  return launched;
}

/**
 * The exit code once the process has ended, or undefined while it still runs. A zero-wait check,
 * so the event loop is never blocked.
 */
export function processExitCode(launched: LaunchedProcess): number | undefined {
  const api = loadLaunchApi();
  const waited = api.waitForSingleObject(launched.processHandle, 0);
  if (waited === WAIT_TIMEOUT) return undefined;
  if (waited !== WAIT_OBJECT_0)
    throw new ProcessSpawnError(
      "SPAWN_FAILED",
      "Could not check whether the command has exited.",
      new Error(
        `WaitForSingleObject failed with Windows error ${api.lastError()}.`,
      ),
    );
  const code = Buffer.alloc(4);
  if (api.getExitCodeProcess(launched.processHandle, code) === 0)
    throw new ProcessSpawnError(
      "SPAWN_FAILED",
      "Could not read the command's exit code.",
      new Error(
        `GetExitCodeProcess failed with Windows error ${api.lastError()}.`,
      ),
    );
  return code.readUInt32LE(0);
}

/** Releases the process handle `launchInJob` returned. */
export function closeLaunchedProcess(launched: LaunchedProcess): void {
  loadLaunchApi().closeHandle(launched.processHandle);
}
