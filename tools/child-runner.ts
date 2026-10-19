import { spawn } from "node:child_process";

export interface RunnerChild {
  onOutput(
    listener: (stream: "stdout" | "stderr", value: Uint8Array) => void,
  ): void;
  onExit(
    listener: (status: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
  onClose(
    listener: (status: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
  onError(listener: (error: Error) => void): void;
  terminate(): Promise<void>;
  dispose(): void;
}

export interface ChildRunnerPort {
  spawn(
    command: string,
    args: readonly string[],
    options: {
      cwd: string;
      env?: NodeJS.ProcessEnv;
      inheritProcessGroup?: boolean;
    },
  ): RunnerChild;
  schedule(ms: number, callback: () => void): () => void;
}

export interface ChildRunOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Nested CI children stay inside the outer step's process group. */
  readonly inheritProcessGroup?: boolean;
  /** Safety bounds: 1..2,147,483,647 ms; callers declare their policy. */
  readonly timeoutMs: number;
  /** Safety bounds: 1..60,000 ms, including unresponsive cleanup helpers. */
  readonly cleanupTimeoutMs: number;
  /** Tail retained separately per stream, bounded to 1..16 MiB. */
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
  readonly acceptableExitCodes?: readonly number[] | null;
  readonly onOutput?: (stream: "stdout" | "stderr", value: string) => void;
}

export interface ChildRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
}

export class ChildRunError extends Error {
  readonly code:
    | "CHILD_TIMEOUT"
    | "CHILD_CANCELLED"
    | "CHILD_START_FAILED"
    | "CHILD_EXIT_FAILED"
    | "CHILD_CLEANUP_FAILED";
  readonly label: string;
  readonly result: ChildRunResult;
  constructor(
    code: ChildRunError["code"],
    label: string,
    detail: string,
    result: ChildRunResult,
    cause?: unknown,
  ) {
    super(
      `${label}: ${detail}\nLast stdout:\n${result.stdout}\nLast stderr:\n${result.stderr}`,
      { cause },
    );
    this.name = "ChildRunError";
    this.code = code;
    this.label = label;
    this.result = result;
  }
}

function missing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ESRCH"
  );
}

const realPort: ChildRunnerPort = {
  schedule(ms, callback) {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
  spawn(command, args, options) {
    const child = spawn(command, args, {
      cwd: options.cwd,
      ...(options.env === undefined ? {} : { env: options.env }),
      detached: process.platform !== "win32" && !options.inheritProcessGroup,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let reaped = false;
    let cleanupHelper: ReturnType<typeof spawn> | undefined;
    child.once("exit", () => {
      reaped = true;
    });
    return {
      onOutput(listener) {
        child.stdout.on("data", (value: Buffer) => listener("stdout", value));
        child.stderr.on("data", (value: Buffer) => listener("stderr", value));
      },
      onExit: (listener) => {
        child.once("exit", listener);
      },
      onClose: (listener) => {
        child.once("close", listener);
      },
      onError: (listener) => {
        child.once("error", listener);
      },
      terminate() {
        const pid = child.pid;
        if (pid === undefined) return Promise.resolve();
        if (process.platform !== "win32") {
          try {
            if (options.inheritProcessGroup) {
              // The outer step owns this group; never signal our own parent group.
              if (reaped) return Promise.resolve();
              child.kill("SIGKILL");
            } else process.kill(-pid, "SIGKILL");
          } catch (error) {
            if (!missing(error))
              return Promise.reject(
                error instanceof Error
                  ? error
                  : new Error("Could not signal child process group", {
                      cause: error,
                    }),
              );
          }
          return reaped
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                child.once("exit", () => resolve());
              });
        }
        // Do not target a potentially reused PID after the direct child was reaped.
        if (reaped) return Promise.resolve();
        return new Promise<void>((resolve, reject) => {
          const killer = spawn(
            "taskkill.exe",
            ["/pid", String(pid), "/T", "/F"],
            { stdio: "ignore", windowsHide: true },
          );
          // The caller bounds this helper too; dispose kills it if it does not finish.
          cleanupHelper = killer;
          killer.once("error", reject);
          killer.once("exit", (status) => {
            if (reaped) resolve();
            else if (status === 0) child.once("exit", () => resolve());
            else reject(new Error(`taskkill exited ${String(status)}`));
          });
        });
      },
      dispose() {
        child.stdout.destroy();
        child.stderr.destroy();
        if (!reaped) child.kill("SIGKILL");
        child.unref();
        cleanupHelper?.kill("SIGKILL");
        cleanupHelper?.unref();
      },
    };
  },
};

/** Every await, including process-tree cleanup and held descendant pipes, is bounded. */
export function runChild(
  label: string,
  command: string,
  args: readonly string[],
  options: ChildRunOptions,
  port: ChildRunnerPort = realPort,
): Promise<ChildRunResult> {
  if (
    options.inheritProcessGroup !== undefined &&
    typeof options.inheritProcessGroup !== "boolean"
  ) {
    throw new TypeError("inheritProcessGroup must be boolean");
  }
  for (const [key, value, maximum] of [
    ["timeoutMs", options.timeoutMs, 2_147_483_647],
    ["cleanupTimeoutMs", options.cleanupTimeoutMs, 60_000],
    ["maxOutputBytes", options.maxOutputBytes, 16 * 1024 * 1024],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
      throw new RangeError(`${key} must be an integer in 1..${maximum}`);
  }
  return new Promise((resolve, reject) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let status: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let child: RunnerChild | undefined;
    let stopping = false;
    let settled = false;
    let cancelDeadline = () => {};
    let cancelCleanup = () => {};
    let failure:
      | { code: ChildRunError["code"]; detail: string; cause?: unknown }
      | undefined;
    const result = (): ChildRunResult => ({
      stdout: stdout.toString("utf8"),
      stderr: stderr.toString("utf8"),
      status,
      signal,
    });
    const finish = () => {
      if (settled) return;
      settled = true;
      cancelDeadline();
      cancelCleanup();
      options.signal?.removeEventListener("abort", abort);
      child?.dispose();
      if (failure)
        reject(
          new ChildRunError(
            failure.code,
            label,
            failure.detail,
            result(),
            failure.cause,
          ),
        );
      else resolve(result());
    };
    const stop = (reason?: typeof failure) => {
      if (settled || stopping) return;
      stopping = true;
      failure = reason;
      cancelDeadline();
      if (child === undefined) {
        finish();
        return;
      }
      cancelCleanup = port.schedule(options.cleanupTimeoutMs, () => {
        failure ??= {
          code: "CHILD_CLEANUP_FAILED",
          detail: `cleanup did not finish within ${options.cleanupTimeoutMs} ms`,
        };
        finish();
      });
      try {
        void child.terminate().then(finish, (cause: unknown) => {
          failure ??= {
            code: "CHILD_CLEANUP_FAILED",
            detail: "could not terminate the child tree",
            cause,
          };
          finish();
        });
      } catch (cause) {
        failure ??= {
          code: "CHILD_CLEANUP_FAILED",
          detail: "could not terminate the child tree",
          cause,
        };
        finish();
      }
    };
    const abort = () =>
      stop({
        code: "CHILD_CANCELLED",
        detail: "cancelled",
        cause: options.signal?.reason,
      });
    if (options.signal?.aborted) {
      abort();
      return;
    }
    options.signal?.addEventListener("abort", abort, { once: true });
    cancelDeadline = port.schedule(options.timeoutMs, () =>
      stop({
        code: "CHILD_TIMEOUT",
        detail: `deadline exceeded after ${options.timeoutMs} ms`,
      }),
    );
    try {
      child = port.spawn(command, args, {
        cwd: options.cwd,
        ...(options.env === undefined ? {} : { env: options.env }),
        inheritProcessGroup: options.inheritProcessGroup ?? false,
      });
      child.onOutput((stream, value) => {
        if (settled) return;
        const bytes = Buffer.from(value);
        const current = stream === "stdout" ? stdout : stderr;
        const tail =
          bytes.length >= options.maxOutputBytes
            ? bytes.subarray(bytes.length - options.maxOutputBytes)
            : Buffer.concat([current, bytes]).subarray(-options.maxOutputBytes);
        if (stream === "stdout") stdout = Buffer.from(tail);
        else stderr = Buffer.from(tail);
        const text = bytes.toString("utf8");
        if (options.onOutput) options.onOutput(stream, text);
        else
          (stream === "stdout" ? process.stdout : process.stderr).write(text);
      });
      child.onExit((code, exitedSignal) => {
        status = code;
        signal = exitedSignal;
      });
      child.onClose((code, exitedSignal) => {
        status = code;
        signal = exitedSignal;
        stop(
          code !== null &&
            (options.acceptableExitCodes === null ||
              (options.acceptableExitCodes ?? [0]).includes(code))
            ? undefined
            : {
                code: "CHILD_EXIT_FAILED",
                detail: `exited ${String(code)}${exitedSignal ? ` (${exitedSignal})` : ""}`,
              },
        );
      });
      child.onError((cause) =>
        stop({ code: "CHILD_START_FAILED", detail: cause.message, cause }),
      );
    } catch (cause) {
      stop({
        code: "CHILD_START_FAILED",
        detail: "could not start child",
        cause,
      });
    }
  });
}
