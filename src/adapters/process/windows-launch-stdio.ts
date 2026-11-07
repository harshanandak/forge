import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { ProcessSpawnError } from "./errors.ts";
import type { SpawnPlan } from "./plan.ts";
import type { WindowsJob } from "./windows-job.ts";
import {
  closeLaunchedProcess,
  launchInJob,
  processExitCode,
  type LaunchOptions,
  type LaunchedProcess,
} from "./windows-launch.ts";

// Runs a command in a per-command job with real stdio. The host listens on one random named pipe
// per stream; the launcher opens the client ends and the command inherits only those. The sockets
// feed the same capture code the helper path feeds today.
const EARLY_POLLS_MS = [1, 2, 4, 8];

export interface CapturedLaunchOptions extends Omit<LaunchOptions, "pipes"> {
  /** Written to the command's stdin, which is then closed. Without it stdin is the NUL device. */
  readonly stdin?: string;
  readonly onStdout: (chunk: Buffer) => void;
  readonly onStderr: (chunk: Buffer) => void;
  /** After four quick checks, how often to look for the exit when the pipes stay open. */
  readonly pollIntervalMs: number;
  /**
   * Runs once every pipe is listening and before the command starts. Tests use it to play another
   * client that reaches the pipes first.
   */
  readonly beforeLaunch?: (names: {
    readonly stdin?: string;
    readonly stdout: string;
    readonly stderr: string;
  }) => Promise<void>;
}

export interface CapturedLaunch {
  readonly pid: number;
  /** The command's exit code, as soon as the process has ended. */
  readonly exited: Promise<number>;
  /** Both output pipes reached end of stream, or capture failed (then this rejects). */
  readonly drained: Promise<void>;
  /** Closes every pipe and the process handle; safe to call more than once. */
  dispose(): void;
}

interface Accepted {
  /** Paused; the caller resumes it once its listeners are attached. */
  readonly socket: Socket;
  /** Bytes that arrived in the same read as the nonce. */
  readonly rest: Buffer;
}

interface PipeServer {
  readonly name: string;
  /** The connection that proved it is the launcher's own client end. */
  readonly connection: Promise<Accepted>;
  /** Stops listening and destroys every connection, now or when it arrives. */
  abandon(): void;
}

function listen(server: Server, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(name, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

/**
 * Another user or process can open a named pipe before the command's own end does, so a connection
 * counts only after its first bytes are the nonce the launcher wrote on its client end. Any other
 * connection is destroyed and the server keeps waiting; the first one that proves itself is the
 * only one kept, and the server then stops listening.
 */
async function openPipe(nonce: Buffer): Promise<PipeServer> {
  const name = `\\\\.\\pipe\\forge-${process.pid}-${randomBytes(16).toString("hex")}`;
  const server = createServer();
  const clients = new Set<Socket>();
  const connection = new Promise<Accepted>((resolve, reject) => {
    server.on("connection", (socket) => {
      clients.add(socket);
      socket.on("error", () => undefined);
      let seen = Buffer.alloc(0);
      const onData = (chunk: Buffer): void => {
        seen = Buffer.concat([seen, chunk]);
        if (seen.length < nonce.length) return;
        socket.off("data", onData);
        if (!timingSafeEqual(seen.subarray(0, nonce.length), nonce)) {
          socket.destroy();
          return;
        }
        socket.pause();
        server.close();
        for (const other of clients) if (other !== socket) other.destroy();
        resolve({ socket, rest: seen.subarray(nonce.length) });
      };
      socket.on("data", onData);
    });
    server.once("error", reject);
  });
  // Nobody may be waiting yet; a rejection is reported through the awaiting caller only.
  connection.catch(() => undefined);
  await listen(server, name);
  return {
    name,
    connection,
    abandon: () => {
      server.close();
      for (const socket of clients) socket.destroy();
    },
  };
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Starts `plan` in `job` and wires its stdout, stderr and optional stdin. Rejects with the same
 * `SPAWN_FAILED` and errno cause a failed start gives today; nothing is left open or running.
 */
export async function launchCaptured(
  plan: SpawnPlan,
  job: WindowsJob,
  options: CapturedLaunchOptions,
): Promise<CapturedLaunch> {
  if (process.platform !== "win32")
    throw new ProcessSpawnError(
      "CONTAINMENT_UNAVAILABLE",
      "The Windows launcher is unavailable on this platform.",
    );
  const pipes: PipeServer[] = [];
  try {
    const nonce = randomBytes(16);
    const stdout = await openPipe(nonce);
    pipes.push(stdout);
    const stderr = await openPipe(nonce);
    pipes.push(stderr);
    const stdin =
      options.stdin === undefined ? undefined : await openPipe(nonce);
    if (stdin !== undefined) pipes.push(stdin);
    await options.beforeLaunch?.({
      stdout: stdout.name,
      stderr: stderr.name,
      ...(stdin === undefined ? {} : { stdin: stdin.name }),
    });
    const launched = launchInJob(plan, job, {
      cwd: options.cwd,
      env: options.env,
      ...(options.windowsHide === undefined
        ? {}
        : { windowsHide: options.windowsHide }),
      pipes: {
        stdout: stdout.name,
        stderr: stderr.name,
        ...(stdin === undefined ? {} : { stdin: stdin.name }),
        nonce,
      },
    });
    return attach(launched, stdout, stderr, stdin, options);
  } catch (error) {
    for (const pipe of pipes) pipe.abandon();
    throw error;
  }
}

function attach(
  launched: LaunchedProcess,
  stdout: PipeServer,
  stderr: PipeServer,
  stdin: PipeServer | undefined,
  options: CapturedLaunchOptions,
): CapturedLaunch {
  const sockets: Socket[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let captureFailure: Error | undefined;
  let rejectDrained!: (error: Error) => void;
  let checkExit: () => void = () => undefined;

  const fail = (error: unknown): void => {
    captureFailure ??= asError(error);
    for (const socket of sockets) socket.destroy();
    rejectDrained(captureFailure);
  };
  const reading = (
    pipe: PipeServer,
    sink: (chunk: Buffer) => void,
  ): Promise<void> =>
    pipe.connection.then(
      ({ socket, rest }) =>
        new Promise<void>((resolve) => {
          sockets.push(socket);
          const feed = (chunk: Buffer): void => {
            try {
              sink(chunk);
            } catch (error) {
              fail(error);
            }
          };
          if (rest.length > 0) feed(rest);
          socket.on("data", feed);
          // A read error means the capture may be partial, so it fails instead of looking complete.
          socket.on("error", fail);
          socket.once("close", () => resolve());
          socket.resume();
        }),
    );
  const outputs = Promise.all([
    reading(stdout, options.onStdout),
    reading(stderr, options.onStderr),
  ]).then(() => {
    // Both pipes ended, which normally means the command exited: look right away.
    checkExit();
  });
  const drained = new Promise<void>((resolve, reject) => {
    rejectDrained = reject;
    outputs.then(resolve, reject);
  });
  // The caller may only look at `exited`; a failed capture must not become unhandled.
  drained.catch(() => undefined);

  if (stdin !== undefined && options.stdin !== undefined) {
    const input = Buffer.from(options.stdin, "utf8");
    stdin.connection.then(({ socket }) => {
      sockets.push(socket);
      socket.on("error", () => undefined);
      // `finish` comes after the command has read everything; closing then gives it end of input.
      socket.once("finish", () => socket.destroy());
      socket.end(input);
    }, fail);
  }

  const exited = new Promise<number>((resolve, reject) => {
    let step = 0;
    const settleIfExited = (): boolean => {
      if (disposed) return true;
      try {
        const code = processExitCode(launched);
        if (code === undefined) return false;
        clearTimeout(timer);
        resolve(code);
      } catch (error) {
        clearTimeout(timer);
        reject(asError(error));
      }
      return true;
    };
    const schedule = (): void => {
      const wait = EARLY_POLLS_MS[step] ?? options.pollIntervalMs;
      step += 1;
      timer = setTimeout(() => {
        if (!settleIfExited()) schedule();
      }, wait);
    };
    checkExit = () => {
      settleIfExited();
    };
    schedule();
  });
  exited.catch(() => undefined);

  return {
    pid: launched.pid,
    exited,
    drained,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      for (const pipe of [stdout, stderr, stdin]) pipe?.abandon();
      for (const socket of sockets) socket.destroy();
      closeLaunchedProcess(launched);
    },
  };
}

/**
 * The post-exit stop: when the command has exited and the job holds no running process, there is
 * nothing to terminate or wait for, so `stop` (and its poll) is skipped. Otherwise it stops the job.
 * A process the command left behind, or one still shutting down such as the console host, keeps the
 * count above 0 for a moment; then the full stop runs, which is always safe.
 */
export async function stopAfterExit(
  job: WindowsJob,
): Promise<{ readonly stopped: readonly number[]; readonly skipped: boolean }> {
  if (job.activeCount() === 0) return { stopped: job.members(), skipped: true };
  return { stopped: await job.stop(), skipped: false };
}
