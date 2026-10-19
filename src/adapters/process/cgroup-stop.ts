import { ProcessSpawnError } from "./errors.ts";

/** Diagnostics cannot prevent the termination operation or its empty-scope confirmation. */
export async function stopCgroupScope(
  actions: {
    snapshot(): readonly number[];
    kill(): void;
    populated(): boolean;
    now(): number;
    pause(ms: number): Promise<void>;
  },
  timing: {
    readonly cleanupTimeoutMs: number;
    readonly pollIntervalMs: number;
  },
): Promise<readonly number[]> {
  let stopped: readonly number[] = [];
  let snapshotFailure: unknown;
  try {
    stopped = actions.snapshot();
  } catch (error) {
    snapshotFailure = error;
  }
  try {
    actions.kill();
  } catch (error) {
    throw new ProcessSpawnError(
      "TREE_KILL_FAILED",
      "The owned cgroup could not be terminated.",
      error,
    );
  }
  const deadline = actions.now() + timing.cleanupTimeoutMs;
  while (true) {
    let populated: boolean;
    try {
      populated = actions.populated();
    } catch (error) {
      throw new ProcessSpawnError(
        "TREE_KILL_FAILED",
        "The owned cgroup termination could not be confirmed.",
        error,
      );
    }
    if (!populated) break;
    const remaining = deadline - actions.now();
    if (remaining <= 0)
      throw new ProcessSpawnError(
        "TREE_KILL_FAILED",
        "The owned cgroup remained populated after termination.",
      );
    await actions.pause(Math.min(timing.pollIntervalMs, remaining));
  }
  if (snapshotFailure !== undefined)
    throw new ProcessSpawnError(
      "TREE_KILL_FAILED",
      "The cgroup was stopped, but its process snapshot was unavailable.",
      snapshotFailure,
    );
  return stopped;
}
