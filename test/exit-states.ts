import type { PidExit } from "../src/adapters/process/windows-job.ts";

// The last few jobs a fixture ended, so a cleanup failure can say whether each killed process had
// really exited. Kept short: the cleanup evidence line is size-bounded.
const MAX_RECORDED = 20;
const recorded: string[] = [];

export function recordExitStates(states: readonly PidExit[]): void {
  for (const { pid, state } of states) recorded.push(`${pid}:${state}`);
  recorded.splice(0, Math.max(0, recorded.length - MAX_RECORDED));
}

/** "pid:signaled|gone|running" for the recently killed processes, or undefined when none ended. */
export function exitStatesLine(): string | undefined {
  return recorded.length ? recorded.join(" ") : undefined;
}
