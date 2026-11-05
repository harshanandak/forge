import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  openWindowsJob,
  type WindowsJob,
} from "../src/adapters/process/windows-job.ts";

// One second for cooperative shutdown, then one second to end the tree and drain pipes.
const CLEANUP_DEADLINE_MS = 2_000;
const SHUTDOWN_GRACE_MS = 1_000;

interface OwnedChild {
  child: ChildProcess;
  closed: Promise<void>;
  isClosed: boolean;
  stop: (() => void) | undefined;
  job: WindowsJob | undefined;
}

async function within<T>(
  work: Promise<T>,
  ms: number,
  message: () => string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message())), Math.max(0, ms));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function holder({ child }: OwnedChild): string {
  const open = [
    child.exitCode === null && child.signalCode === null ? "process exit" : "",
    child.stdout && !child.stdout.closed ? "stdout" : "",
    child.stderr && !child.stderr.closed ? "stderr" : "",
  ].filter(Boolean);
  return `PID ${child.pid ?? "unspawned"} (${child.spawnargs[0]}): ${open.join(", ") || "child close"}`;
}

export class FixtureChildren {
  private readonly pending = new Set<OwnedChild>();

  // Already-started children retain cooperative shutdown only, with no job or group signals.
  own<T extends ChildProcess>(child: T, stop?: () => void): T {
    const entry: OwnedChild = {
      child,
      closed: new Promise<void>((resolve) => child.once("close", resolve)),
      isClosed: false,
      stop,
      job: undefined,
    };
    this.pending.add(entry);
    void entry.closed.then(() => {
      entry.isClosed = true;
      if (!entry.job) {
        this.pending.delete(entry);
      }
    });
    return child;
  }

  private async endJob(entry: OwnedChild): Promise<void> {
    if (!entry.job) return;
    try {
      await entry.job.stop();
    } finally {
      entry.job.close();
    }
    entry.job = undefined;
  }

  spawn(
    command: string,
    args: string[],
    options: SpawnOptionsWithoutStdio,
  ): ChildProcessWithoutNullStreams {
    const windows = process.platform === "win32";
    const job = windows
      ? openWindowsJob({
          cleanupTimeoutMs: SHUTDOWN_GRACE_MS,
          pollIntervalMs: 10,
        })
      : undefined;
    let child: ChildProcessWithoutNullStreams | undefined;
    try {
      child = this.own(
        spawn(
          windows ? Bun.which("node")! : command,
          windows
            ? [
                fileURLToPath(
                  new URL("./fixture-child-leader.ts", import.meta.url),
                ),
                command,
                JSON.stringify(args),
              ]
            : args,
          {
            ...options,
            stdio: windows
              ? ["pipe", "pipe", "pipe", "ipc"]
              : ["pipe", "pipe", "pipe"],
          },
        ) as ChildProcessWithoutNullStreams,
      );
      const entry = [...this.pending].find((owned) => owned.child === child)!;
      entry.job = job;
      if (job) {
        job.attach(child.pid!);
        // The waiting leader cannot fork until assignment has succeeded.
        child.send({ start: true });
      }
      return child;
    } catch (error) {
      job?.close();
      child?.kill("SIGKILL");
      throw error;
    }
  }

  run(command: string, args: string[], options: SpawnOptionsWithoutStdio) {
    const child = this.spawn(command, args, options);
    const entry = [...this.pending].find((owned) => owned.child === child)!;
    let stdout = "";
    let stderr = "";
    let error: Error | undefined;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (cause) => {
      error = cause;
    });
    child.on("message", (message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "error" in message &&
        typeof message.error === "string"
      ) {
        error = Object.assign(
          new Error(message.error),
          "code" in message ? { code: message.code } : {},
        );
      }
    });
    child.stdin.end();
    // On Windows, end the retained job before waiting for inherited capture pipes.
    const ended = new Promise<void>((resolve) => {
      child.once("exit", () => {
        void this.endJob(entry)
          .catch((cause: unknown) => {
            error = cause instanceof Error ? cause : new Error(String(cause));
          })
          .finally(resolve);
      });
      child.once("error", () => resolve());
    });
    return (async () => {
      await ended;
      await within(
        entry.closed,
        CLEANUP_DEADLINE_MS,
        () => `Fixture cleanup deadline: ${holder(entry)}`,
      );
      this.pending.delete(entry);
      return { status: child.exitCode, stdout, stderr, error };
    })();
  }

  async cleanup(remove: () => void): Promise<void> {
    const deadline = performance.now() + CLEANUP_DEADLINE_MS;
    const failures: unknown[] = [];
    await Promise.all(
      [...this.pending].map(async (entry) => {
        const describe = () => `Fixture cleanup deadline: ${holder(entry)}`;
        try {
          if (entry.stop && !entry.isClosed) {
            try {
              const stop = entry.stop;
              entry.stop = undefined;
              stop();
              await within(entry.closed, SHUTDOWN_GRACE_MS, describe);
            } catch (error) {
              failures.push(error);
            }
          }
          await within(
            this.endJob(entry),
            deadline - performance.now(),
            describe,
          );
          await within(entry.closed, deadline - performance.now(), describe);
          this.pending.delete(entry);
        } catch (error) {
          failures.push(error);
        }
      }),
    );
    if (failures.length) {
      throw new AggregateError(
        failures,
        failures.map((error) => String(error)).join("; "),
      );
    }
    remove();
  }
}
