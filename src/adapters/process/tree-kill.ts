import { spawn } from "node:child_process";
import { envValue } from "./env.ts";
import { pathFor, type Platform } from "./platform.ts";

/**
 * Stop a process and everything it started. POSIX children run as the leader of their own process
 * group, so one signal to the group reaches them all. Windows has no groups; `taskkill /T` walks
 * the tree from the root pid.
 */
export function killTree(
  pid: number,
  platform: Platform,
  env: Readonly<Record<string, string>>,
): void {
  if (platform === "win32") {
    const root =
      envValue(env, "SystemRoot", platform) ??
      process.env["SystemRoot"] ??
      "C:\\Windows";
    const taskkill = pathFor(platform).join(root, "System32", "taskkill.exe");
    const killer = spawn(taskkill, ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      env: { SystemRoot: root },
    });
    killer.on("error", () => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}
