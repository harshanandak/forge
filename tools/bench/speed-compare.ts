// How the Speed gate decides this build is slower than the base build. Pure functions over timings,
// so the decision can be tested with injected numbers and no process.

/** This build may take at most this multiple of the base build's time. */
export const MAX_RATIO_TO_BASE = 1.05;

export type Side = "current" | "base";

/**
 * The order the timed runs take: the pair order flips every pair (current, base, base, current, ...)
 * so a slow stretch of the runner does not always land on the same build.
 */
export function sampleOrder(pairs: number): Side[] {
  const order: Side[] = [];
  for (let n = 0; n < pairs; n += 1)
    order.push(
      ...(n % 2 === 0
        ? (["current", "base"] as const)
        : (["base", "current"] as const)),
    );
  return order;
}

const sorted = (values: readonly number[]): number[] =>
  [...values].sort((a, b) => a - b);

/** The time a build is scored by. */
export const SCORE_LABEL = "median";
export function score(times: readonly number[]): number {
  if (times.length === 0) throw new Error("no timings to score");
  return sorted(times)[Math.floor(times.length / 2)]!;
}

export interface Comparison {
  readonly currentMs: number;
  readonly baseMs: number;
  readonly ratio: number;
  /** False when this build is more than `maxRatio` times the base build. */
  readonly passed: boolean;
}

export function compareToBase(
  current: readonly number[],
  base: readonly number[],
  maxRatio: number = MAX_RATIO_TO_BASE,
): Comparison {
  const currentMs = score(current);
  const baseMs = score(base);
  const ratio = currentMs / baseMs;
  return { currentMs, baseMs, ratio, passed: !(currentMs > maxRatio * baseMs) };
}
