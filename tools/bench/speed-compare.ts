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

/** What a build is scored by, named in the failure message. */
export const SCORE_LABEL = "25th percentile";

/**
 * A build's score is its 25th percentile run (nearest rank: the 3rd fastest of 9). Runner load only
 * ever slows a run, so the fast end of the samples tracks the build's true cost, while the middle
 * of them tracks the runner's mood. It is not the minimum: one lucky fast run cannot hide a real
 * regression, because the 2 faster runs would have to be lucky too.
 */
export function score(times: readonly number[]): number {
  if (times.length === 0) throw new Error("no timings to score");
  return sorted(times)[Math.floor((times.length - 1) / 4)]!;
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
