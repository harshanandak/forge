import {
  execFile,
  spawn,
  spawnSync,
  type SpawnOptions,
} from "node:child_process";
import { promisify } from "node:util";

const inspect = promisify(execFile);

async function groupStopped(pid: number): Promise<void> {
  const deadline = performance.now() + 1000;
  // Signal delivery precedes process exit. Zombies cannot run, but may remain until reaped.
  while (true) {
    let stdout: string;
    try {
      ({ stdout } = await inspect("ps", ["-A", "-o", "pgid=,stat="], {
        timeout: Math.max(1, Math.ceil(deadline - performance.now())),
        maxBuffer: 1024 * 1024,
      }));
    } catch (error) {
      // A failed snapshot proves nothing; ESRCH from the OS proves the group is gone.
      try {
        process.kill(-pid, 0);
      } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code === "ESRCH") return;
      }
      throw error;
    }
    if (
      !stdout.split("\n").some((line) => {
        const [group, state] = line.trim().split(/\s+/);
        return Number(group) === pid && !state?.startsWith("Z");
      })
    )
      return;
    if (performance.now() >= deadline)
      throw new Error("process group still running");
  }
}

/**
 * Run a command with inherited output under one outer deadline. On the deadline the whole process
 * tree is ended (taskkill /T on Windows, the process group elsewhere) and the run rejects with the
 * phase name, so a hang outside any test callback fails fast instead of riding the job ceiling.
 */
export function runWithin(
  phase: string,
  command: string,
  args: readonly string[],
  options: Omit<SpawnOptions, "stdio" | "detached">,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const windows = process.platform === "win32";
    const child = spawn(command, args, {
      ...options,
      stdio: "inherit",
      windowsHide: true,
      // Its own process group, so the deadline can end every descendant on POSIX.
      detached: !windows,
    });
    const forward = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The group already exited.
      }
    };
    const onInt = (): void => forward("SIGINT");
    const onTerm = (): void => forward("SIGTERM");
    if (!windows) {
      process.on("SIGINT", onInt);
      process.on("SIGTERM", onTerm);
    }
    const detach = (): void => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
    };
    const stopGroup = (): boolean => {
      if (windows || child.pid === undefined) return false;
      try {
        process.kill(-child.pid, "SIGKILL");
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ESRCH") return false;
        // macOS can refuse SIGKILL for a zombie-only group. Require the same OS
        // snapshot proof as a delivered signal; a live or unknown group still fails.
        if (code === "EPERM") return true;
        throw error;
      }
    };
    let settled = false;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanupFailure: Error | undefined;
    const settle = async (failure?: Error): Promise<void> => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      detach();
      try {
        // The leader exiting does not end its group: a descendant may ignore the forwarded signal.
        if (stopGroup()) await groupStopped(child.pid!);
      } catch (error) {
        reject(
          new Error(`${phase}: process group cleanup failed`, { cause: error }),
        );
        return;
      }
      if (failure) reject(failure);
      else resolve();
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid === undefined) {
        void settle(new Error(`${phase} timed out after ${timeoutMs} ms`));
        return;
      }
      if (windows) {
        const result = spawnSync(
          "taskkill",
          ["/T", "/F", "/PID", String(child.pid)],
          { windowsHide: true, timeout: 5000, killSignal: "SIGKILL" },
        );
        if (result.error || result.status !== 0)
          cleanupFailure = new Error(
            `${phase}: taskkill failed (${(result.error as NodeJS.ErrnoException | undefined)?.code ?? `exit ${String(result.status)}`}); process tree cleanup unconfirmed`,
            { cause: result.error },
          );
        cleanupTimer = setTimeout(() => {
          void settle(
            cleanupFailure ??
              new Error(
                `${phase}: process tree cleanup timed out after taskkill`,
              ),
          );
        }, 1000);
        if (cleanupFailure) {
          try {
            child.kill("SIGKILL");
          } catch {
            // The bounded grace still rejects if even the direct kill is refused.
          }
        }
      } else {
        void settle(
          new Error(
            `${phase} timed out after ${timeoutMs} ms; its process tree was killed`,
          ),
        );
      }
    }, timeoutMs);
    child.once("error", (error) => {
      void settle(new Error(`${phase}: ${error.message}`));
    });
    child.once("exit", (code, signal) => {
      if (timedOut)
        void settle(
          cleanupFailure ??
            new Error(
              `${phase} timed out after ${timeoutMs} ms; its process tree was killed`,
            ),
        );
      else if (code !== 0)
        void settle(
          new Error(`${phase} failed: exit ${String(code ?? signal)}`),
        );
      else void settle();
    });
  });
}
