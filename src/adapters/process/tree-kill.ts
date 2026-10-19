import { setTimeout as sleep } from "node:timers/promises";
import { ProcessSpawnError } from "./errors.ts";

interface GroupControl {
  signal(pid: number, signal: "SIGKILL" | 0): void;
  now(): number;
  pause(ms: number): Promise<void>;
}
const realGroupControl: GroupControl = {
  signal(pid, signal) {
    process.kill(pid, signal);
  },
  now: () => performance.now(),
  pause: async (ms) => {
    await sleep(ms);
  },
};

/** A POSIX scope owns its helper's process group until command settlement. */
export async function killTree(
  pid: number,
  timing: {
    readonly cleanupTimeoutMs: number;
    readonly pollIntervalMs: number;
  },
  control: GroupControl = realGroupControl,
): Promise<void> {
  try {
    control.signal(-pid, "SIGKILL");
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
  const deadline = control.now() + timing.cleanupTimeoutMs;
  while (true) {
    try {
      control.signal(-pid, 0);
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ESRCH"
      )
        return;
      // EPERM is ambiguous while a signalled group is being reaped. Only ESRCH proves absence.
      if (!(
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "EPERM"
      ))
        throw new ProcessSpawnError(
          "TREE_KILL_FAILED",
          "Could not confirm process group termination",
          error,
        );
    }
    const remaining = deadline - control.now();
    if (remaining <= 0)
      throw new ProcessSpawnError(
        "TREE_KILL_FAILED",
        "Process group remained alive after termination",
      );
    await control.pause(Math.min(timing.pollIntervalMs, remaining));
  }
}
