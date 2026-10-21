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
    const { stdout } = await inspect("ps", ["-A", "-o", "pgid=,stat="], {
      timeout: Math.max(1, Math.ceil(deadline - performance.now())),
      maxBuffer: 1024 * 1024,
    });
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
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        return false;
      }
    };
    let settled = false;
    const settle = async (failure?: Error): Promise<void> => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
      if (child.pid === undefined) return;
      if (windows)
        spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
          windowsHide: true,
        });
      else {
        try {
          stopGroup();
        } catch (error) {
          void settle(
            new Error(`${phase}: process group cleanup failed`, {
              cause: error,
            }),
          );
        }
      }
    }, timeoutMs);
    child.once("error", (error) => {
      void settle(new Error(`${phase}: ${error.message}`));
    });
    child.once("exit", (code, signal) => {
      if (timedOut)
        void settle(
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
