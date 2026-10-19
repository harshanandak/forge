import { setTimeout as sleep } from "node:timers/promises";
import { ProcessSpawnError } from "./errors.ts";

/** A POSIX scope owns its helper's process group until command settlement. */
export async function killTree(
  pid: number,
  timing: {
    readonly cleanupTimeoutMs: number;
    readonly pollIntervalMs: number;
  },
): Promise<void> {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (!(
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ESRCH"
    ))
      throw new ProcessSpawnError(
        "TREE_KILL_FAILED",
        "Could not stop process group",
        error,
      );
  }
  const deadline = performance.now() + timing.cleanupTimeoutMs;
  while (true) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ESRCH"
      )
        return;
      throw new ProcessSpawnError(
        "TREE_KILL_FAILED",
        "Could not confirm process group termination",
        error,
      );
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0)
      throw new ProcessSpawnError(
        "TREE_KILL_FAILED",
        "Process group remained alive after termination",
      );
    await sleep(Math.min(timing.pollIntervalMs, remaining));
  }
}
