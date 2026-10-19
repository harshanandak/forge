import { spawn } from "node:child_process";
import { pathFor, type Platform } from "./platform.ts";
import { ProcessSpawnError } from "./errors.ts";

/** POSIX uses an owned process group; Windows taskkill must come from the host, never child env. */
export function killTree(pid: number, platform: Platform): Promise<void> {
  if (platform === "win32") {
    const root = process.env.SystemRoot ?? "C:/Windows";
    const taskkill = pathFor(platform).join(root, "System32", "taskkill.exe");
    return new Promise((resolve, reject) => {
      const killer = spawn(taskkill, ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        env: { SystemRoot: root },
      });
      let settled = false;
      const finish = (failure?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (failure === undefined) {
          resolve();
          return;
        }
        // Best effort still stops the root, but cannot be reported as a confirmed tree kill.
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* the root has exited */
        }
        reject(
          new ProcessSpawnError(
            "TREE_KILL_FAILED",
            "Could not confirm process tree termination",
            failure,
          ),
        );
      };
      const timer = setTimeout(() => {
        killer.kill();
        finish(new Error("Tree termination timed out"));
      }, 4000);
      killer.once("error", finish);
      killer.once("close", (code) =>
        finish(code === 0 ? undefined : new Error("Tree termination failed")),
      );
    });
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (!(
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ESRCH"
    ))
      return Promise.reject(
        new ProcessSpawnError(
          "TREE_KILL_FAILED",
          "Could not stop process group",
          error,
        ),
      );
  }
  return Promise.resolve();
}
