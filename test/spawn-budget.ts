import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";
import { rmSync } from "node:fs";

/**
 * Time kept back from the test's declared timeout for work that is not a spawn: fixture writes,
 * JSON parsing and cleanup. The test bodies that use this are synchronous, so Bun's own test
 * timeout cannot interrupt them; the per-call spawn timeout is the only bound that fires. A hang
 * therefore fails after about (test timeout - reserve), not after a fixed few seconds.
 */
export const SCENARIO_RESERVE_MS = 5_000;

type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>;

export type SpawnBudget = {
  /** Milliseconds left in the scenario, never below 0. */
  remainingMs(): number;
  /**
   * Spawns with whatever is left of the scenario budget as the timeout. Throws without spawning
   * when under 1 ms is left (a timeout of 0 would mean no limit). Throws when the call is killed
   * or fails to start, or when `expectStatus` is given and the exit status differs; the message
   * names the call and the durations of the calls before it.
   */
  run(
    label: string,
    command: string,
    args: readonly string[],
    options?: Omit<SpawnSyncOptionsWithStringEncoding, "encoding" | "timeout">,
    expectStatus?: number,
  ): SpawnSyncReturns<string>;
};

/** Starts the scenario clock now, from the test's declared timeout. */
export function spawnBudget(
  testTimeoutMs: number,
  inject: { now?: () => number; spawn?: SpawnFn; reserveMs?: number } = {},
): SpawnBudget {
  const now = inject.now ?? Date.now;
  const spawn: SpawnFn = inject.spawn ?? spawnSync;
  const budgetMs = testTimeoutMs - (inject.reserveMs ?? SCENARIO_RESERVE_MS);
  const started = now();
  const spent: string[] = [];
  const remainingMs = () => Math.max(0, budgetMs - (now() - started));
  return {
    remainingMs,
    run(label, command, args, options = {}, expectStatus) {
      const left = Math.floor(remainingMs());
      if (left < 1)
        throw new Error(
          `${label} was not started: the ${budgetMs} ms scenario budget is used up by ${spent.join("; ") || "nothing"}`,
        );
      const callStarted = now();
      const result = spawn(command, args, {
        ...options,
        encoding: "utf8",
        windowsHide: true,
        timeout: left,
      });
      const took = now() - callStarted;
      const earlier = spent.join("; ") || "none";
      spent.push(`${label} ${took} ms`);
      const output = [result.stderr, result.stdout].filter(Boolean).join("");
      const detail = output ? `\n${output}` : "";
      if (result.status === null)
        throw new Error(
          `${label} was killed after ${took} ms of a ${left} ms budget (status null; signal ${result.signal ?? "none"}; error ${result.error?.message ?? "none"}); earlier calls: ${earlier}${detail}`,
        );
      if (expectStatus !== undefined && result.status !== expectStatus)
        throw new Error(
          `${label} exited ${result.status}, expected ${expectStatus}, after ${took} ms of a ${left} ms budget; earlier calls: ${earlier}${detail}`,
        );
      return result;
    },
  };
}

/**
 * Removes a temp folder for a `finally` block. A cleanup failure (Windows EBUSY) must not replace
 * the test's own error, and a leaked temp folder costs nothing.
 */
export function removeQuietly(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Best effort: the diagnostic from the test body matters more than the leftover folder.
  }
}
