import { spawn, spawnSync, type SpawnOptions } from "node:child_process";

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
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid === undefined) return;
      if (windows)
        spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
          windowsHide: true,
        });
      else
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // The group already exited.
        }
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      detach();
      reject(new Error(`${phase}: ${error.message}`));
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      detach();
      if (timedOut)
        reject(
          new Error(
            `${phase} timed out after ${timeoutMs} ms; its process tree was killed`,
          ),
        );
      else if (code !== 0)
        reject(new Error(`${phase} failed: exit ${String(code ?? signal)}`));
      else resolve();
    });
  });
}
