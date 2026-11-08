// Edge cases of the Windows launcher's captured path: large and unread stdin, big exit codes, a
// descendant that holds stdout, disposal before the command ends, a failed attach, and a pipe
// served by another process. The same file is the child program, and prints a report under Node.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureStreams } from "../../../src/adapters/process/capture.ts";
import { planSpawn } from "../../../src/adapters/process/plan.ts";
import { launchInJob } from "../../../src/adapters/process/windows-launch.ts";
import { openWindowsJob } from "../../../src/adapters/process/windows-job.ts";
import {
  launchCaptured,
  launchCapturedWith,
  stopCaptured,
  type CapturedLaunch,
  type LaunchHooks,
} from "../../../src/adapters/process/windows-launch-stdio.ts";

export const fixturePath = fileURLToPath(import.meta.url);

const neutralCwd = tmpdir();
const root = process.env.SystemRoot ?? "C:\\Windows";
const env = { SystemRoot: root };
const BIG_INPUT_BYTES = 256 * 1024;
const UNREAD_INPUT_BYTES = 1024 * 1024;

export interface RobustReport {
  readonly bigStdin: {
    readonly exitCode: number;
    readonly inputSha256: string;
    readonly echoedSha256: string;
    readonly echoedBytes: number;
  };
  readonly unreadStdin: { readonly exitCode: number };
  readonly bigExit: { readonly exitCode: number };
  readonly lingering: {
    readonly exitCode: number;
    readonly pipesClosed: boolean;
    readonly descendantStopped: boolean;
    readonly descendantGone: boolean;
  };
  readonly disposed: readonly {
    readonly when: "at once" | "after verification";
    readonly exited: string;
    readonly drained: string;
  }[];
  readonly attachFailure: {
    readonly message: string;
    readonly jobEmptied: boolean;
  };
  readonly foreignServer: {
    readonly code: unknown;
    readonly message: string;
    readonly started: boolean;
    readonly serverReceivedBytes: number;
  };
}

function job(): ReturnType<typeof openWindowsJob> {
  return openWindowsJob({ cleanupTimeoutMs: 5000, pollIntervalMs: 25 });
}

function plan(nodePath: string, mode: string) {
  return planSpawn(nodePath, [fixturePath, mode], env, "win32");
}

function bytesOf(size: number): Buffer {
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1)
    bytes[index] = 33 + ((index * 7) % 90);
  return bytes;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function until(done: () => boolean, ms: number): Promise<boolean> {
  const deadline = performance.now() + ms;
  while (!done()) {
    if (performance.now() >= deadline) return false;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  return true;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function outcome(promise: Promise<unknown>): Promise<string> {
  const timeout = new Promise<string>((resolveTimeout) =>
    setTimeout(() => resolveTimeout("still pending"), 3000),
  );
  const settled = promise.then(
    () => "resolved",
    (error: unknown) =>
      error !== null && typeof error === "object" && "code" in error
        ? String(error.code)
        : "rejected",
  );
  return Promise.race([settled, timeout]);
}

/** Runs a mode of this file to its end through the captured path and the post-exit stop. */
async function run(
  nodePath: string,
  mode: string,
  stdin?: Buffer,
  drainTimeoutMs = 5000,
): Promise<{
  exitCode: number;
  stdout: Buffer;
  pipesClosed: boolean;
  stopped: readonly number[];
}> {
  const owner = job();
  const { stdout } = captureStreams({
    cwd: neutralCwd,
    env,
    timeoutMs: 60_000,
    maxOutputBytes: 4 * 1024 * 1024,
    capture: { headBytes: 2 * 1024 * 1024, tailBytes: 0 },
  });
  let launch: CapturedLaunch | undefined;
  try {
    launch = await launchCaptured(plan(nodePath, mode), owner, {
      cwd: neutralCwd,
      env,
      pollIntervalMs: 25,
      ...(stdin === undefined ? {} : { stdin: stdin.toString("latin1") }),
      onStdout: (chunk) => stdout.push(chunk),
      onStderr: () => undefined,
    });
    const exitCode = await launch.exited;
    const stop = await stopCaptured(launch, owner, {
      drainTimeoutMs,
      commandExited: true,
    });
    return {
      exitCode,
      stdout: Buffer.from(stdout.evidence(true).head, "base64"),
      pipesClosed: stop.pipesClosed,
      stopped: stop.stopped,
    };
  } finally {
    try {
      launch?.dispose();
    } finally {
      owner.close();
    }
  }
}

async function disposeScenario(
  nodePath: string,
  when: "at once" | "after verification",
): Promise<RobustReport["disposed"][number]> {
  const owner = job();
  let launch: CapturedLaunch | undefined;
  try {
    launch = await launchCaptured(plan(nodePath, "idle"), owner, {
      cwd: neutralCwd,
      env,
      pollIntervalMs: 25,
      onStdout: () => undefined,
      onStderr: () => undefined,
    });
    // Disposing right away runs before the host has read the nonce on any pipe.
    if (when === "after verification")
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    launch.dispose();
    return {
      when,
      exited: await outcome(launch.exited),
      drained: await outcome(launch.drained),
    };
  } finally {
    try {
      await owner.stop();
    } finally {
      owner.close();
    }
  }
}

async function attachFailureScenario(
  nodePath: string,
): Promise<RobustReport["attachFailure"]> {
  const owner = job();
  const hooks: LaunchHooks = {
    afterLaunch: () => {
      throw new Error("injected attach failure");
    },
  };
  let message = "launch succeeded";
  try {
    try {
      const launch = await launchCapturedWith(
        plan(nodePath, "idle"),
        owner,
        {
          cwd: neutralCwd,
          env,
          pollIntervalMs: 25,
          onStdout: () => undefined,
          onStderr: () => undefined,
        },
        hooks,
      );
      launch.dispose();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    // The command was already running in the job; the failed launch must have ended it.
    const jobEmptied = await until(() => owner.activeCount() === 0, 5000);
    return { message, jobEmptied };
  } finally {
    try {
      await owner.stop();
    } finally {
      owner.close();
    }
  }
}

/** Another process hosts the pipe the launcher is told to use. It must never get a byte. */
async function foreignServerScenario(
  nodePath: string,
): Promise<RobustReport["foreignServer"]> {
  const name = `\\\\.\\pipe\\forge-foreign-${process.pid}-${Date.now()}`;
  const server = spawn(nodePath, [fixturePath, "serve", name], {
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
  });
  const owner = job();
  try {
    await new Promise<void>((resolveReady, rejectReady) => {
      server.once("error", rejectReady);
      server.stdout.once("data", () => resolveReady());
    });
    let code: unknown = "launched";
    let message = "";
    let started = true;
    try {
      launchInJob(plan(nodePath, "idle"), owner, {
        cwd: neutralCwd,
        env,
        pipes: { stdout: name, nonce: Buffer.from("0123456789abcdef") },
      });
    } catch (error) {
      started = false;
      if (error instanceof Error) {
        message = error.message;
        code = "code" in error ? error.code : undefined;
      }
    }
    const received = new Promise<number>((resolveBytes) => {
      let text = "";
      server.stdout.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
        const match = /bytes:(\d+)\n/.exec(text);
        if (match !== null) resolveBytes(Number(match[1]));
      });
    });
    server.stdin.write("report\n");
    return {
      code,
      message,
      started: started || owner.activeCount() !== 0,
      serverReceivedBytes: await received,
    };
  } finally {
    server.kill();
    try {
      await owner.stop();
    } finally {
      owner.close();
    }
  }
}

export async function robustScenarios(nodePath: string): Promise<RobustReport> {
  const input = bytesOf(BIG_INPUT_BYTES);
  const big = await run(nodePath, "echo", input);
  const unread = await run(nodePath, "ignore", bytesOf(UNREAD_INPUT_BYTES));
  const bigExit = await run(nodePath, "exit300");
  const lingering = await run(nodePath, "linger");
  const descendant = Number(
    /descendant:(\d+)/.exec(lingering.stdout.toString("utf8"))?.[1],
  );
  return {
    bigStdin: {
      exitCode: big.exitCode,
      inputSha256: sha256(input),
      echoedSha256: sha256(big.stdout),
      echoedBytes: big.stdout.length,
    },
    unreadStdin: { exitCode: unread.exitCode },
    bigExit: { exitCode: bigExit.exitCode },
    lingering: {
      exitCode: lingering.exitCode,
      pipesClosed: lingering.pipesClosed,
      descendantStopped: lingering.stopped.includes(descendant),
      descendantGone: await until(() => !alive(descendant), 5000),
    },
    disposed: [
      await disposeScenario(nodePath, "at once"),
      await disposeScenario(nodePath, "after verification"),
    ],
    attachFailure: await attachFailureScenario(nodePath),
    foreignServer: await foreignServerScenario(nodePath),
  };
}

const isEntry =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]).toLowerCase() === fixturePath.toLowerCase();

if (isEntry) {
  const [mode, argument] = process.argv.slice(2);
  if (mode === "run") {
    process.stdout.write(
      JSON.stringify(await robustScenarios(process.execPath)),
    );
  } else if (mode === "echo") {
    process.stdin.pipe(process.stdout);
  } else if (mode === "ignore") {
    // Exits without reading the input the launcher is still writing.
    process.exitCode = 0;
  } else if (mode === "exit300") {
    process.exitCode = 300;
  } else if (mode === "idle") {
    setInterval(() => undefined, 1000);
  } else if (mode === "linger") {
    // A detached descendant keeps stdout open after this command exits.
    const descendant = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        detached: true,
        stdio: ["ignore", "inherit", "inherit"],
        windowsHide: true,
      },
    );
    descendant.unref();
    process.stdout.write(`descendant:${descendant.pid}\n`);
  } else if (mode === "serve" && argument !== undefined) {
    // Counts what any client sends; reports the total when asked.
    let received = 0;
    const server = createServer((socket) => {
      socket.on("data", (chunk: Buffer) => {
        received += chunk.length;
      });
      socket.on("error", () => undefined);
    });
    server.listen(argument, () => process.stdout.write("ready\n"));
    process.stdin.on("data", () => {
      process.stdout.write(`bytes:${received}\n`);
    });
  }
}
