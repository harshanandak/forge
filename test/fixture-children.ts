import {
  spawn,
  type ChildProcess,
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

/** Own immediately after spawn; on POSIX spawn detached to give the tree its own group. */
export class FixtureChildren {
  private readonly pending = new Set<OwnedChild>();

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
    });
    if (process.platform === "win32" && child.pid !== undefined) {
      try {
        entry.job = openWindowsJob({
          cleanupTimeoutMs: SHUTDOWN_GRACE_MS,
          pollIntervalMs: 10,
        });
        entry.job.attach(child.pid);
      } catch (error) {
        entry.job?.close();
        child.kill("SIGKILL");
        throw error;
      }
    }
    return child;
  }

  private async endTree(entry: OwnedChild): Promise<void> {
    if (entry.job) {
      try {
        await entry.job.stop();
      } finally {
        entry.job.close();
      }
      entry.job = undefined;
    } else if (process.platform !== "win32" && entry.child.pid !== undefined) {
      try {
        process.kill(-entry.child.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        if (!entry.isClosed) entry.child.kill("SIGKILL");
      }
    } else if (!entry.isClosed) {
      entry.child.kill("SIGKILL");
    }
  }

  run(command: string, args: string[], options: SpawnOptionsWithoutStdio) {
    const windows = process.platform === "win32";
    const child = this.own(
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
          detached: !windows,
          stdio: windows
            ? ["pipe", "pipe", "pipe", "ipc"]
            : ["pipe", "pipe", "pipe"],
        },
      ),
    );
    const entry = [...this.pending].find((owned) => owned.child === child)!;
    let stdout = "";
    let stderr = "";
    let error: Error | undefined;
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
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
    // The Windows leader cannot fork until own() has attached its Job Object.
    child.stdin!.end(windows ? "start" : undefined);
    // A completed command must not leave an orphan holding its capture pipes open.
    const ended = new Promise<void>((resolve) => {
      child.once("exit", () => {
        void this.endTree(entry)
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
    const entries = [...this.pending];
    const failures: unknown[] = [];
    await Promise.all(
      entries.map(async (entry) => {
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
            this.endTree(entry),
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
