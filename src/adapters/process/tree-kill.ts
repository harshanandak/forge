import { setTimeout as sleep } from "node:timers/promises";
import { ProcessSpawnError } from "./errors.ts";
import {
  linuxProcessTable,
  type ProcessTablePort,
} from "./linux-process-table.ts";
import { darwinProcessTable } from "./darwin-process-table.ts";

interface GroupControl {
  readonly processTable?: ProcessTablePort;
  signal(pid: number, signal: "SIGKILL" | 0): void;
  now(): number;
  pause(ms: number): Promise<void>;
}
const realGroupControl: GroupControl = {
  ...(process.platform === "linux" ? { processTable: linuxProcessTable } : {}),
  ...(process.platform === "darwin"
    ? { processTable: darwinProcessTable }
    : {}),
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
  const deadline = control.now() + timing.cleanupTimeoutMs;
  while (true) {
    // Group signalling snapshots membership on Darwin. A descendant published
    // after one signal must receive the next one, within the same cleanup budget.
    try {
      control.signal(-pid, "SIGKILL");
    } catch (error) {
      if (!(
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        (error.code === "ESRCH" ||
          (error.code === "EPERM" && control.processTable !== undefined))
      ))
        throw new ProcessSpawnError(
          "TREE_KILL_FAILED",
          "Could not stop process group",
          error,
        );
    }
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
    if (control.processTable !== undefined) {
      const checkBudget = (): void => {
        if (control.now() >= deadline)
          throw new Error(
            "Process table inspection exceeded the cleanup deadline",
          );
      };
      try {
        let live = false;
        let zombies = false;
        for (const member of control.processTable.members(pid, checkBudget)) {
          checkBudget();
          if (member.state === "Z") zombies = true;
          else {
            live = true;
            break;
          }
        }
        checkBudget();
        if (!live) {
          // An empty inventory can race a newly published child. A fresh group
          // probe must agree; Darwin reports EPERM when only dead members remain.
          try {
            control.signal(-pid, 0);
            checkBudget();
            if (zombies) return;
          } catch (error) {
            if (
              error !== null &&
              typeof error === "object" &&
              "code" in error &&
              (error.code === "ESRCH" || error.code === "EPERM")
            )
              return;
            throw error;
          }
        }
      } catch (error) {
        throw new ProcessSpawnError(
          "TREE_KILL_FAILED",
          "Could not inspect process group members",
          error,
        );
      }
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
