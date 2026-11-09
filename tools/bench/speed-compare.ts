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

/** The limits for one platform. */
export interface GateLimit {
  readonly ceilingMs: number;
  readonly maxPeakMb: number;
}

/** What the gate reads from one measured command. */
export interface GateRow {
  readonly medianMs: number;
  readonly medianPeakMb: number;
  readonly timesMs: readonly number[];
}

export interface GateDecision {
  readonly failures: string[];
  readonly warnings: string[];
}

/**
 * The Speed gate's whole decision for the gated command. `baseRow` is the base build measured in
 * the same job, or undefined when it is missing. `where` only words the messages.
 */
export function gateDecision(
  limit: GateLimit,
  row: GateRow,
  baseRow: GateRow | undefined,
  where: {
    readonly command: string;
    readonly platform: string;
    readonly baseMissing: string;
  },
): GateDecision {
  const { command, platform } = where;
  const failures: string[] = [];
  const warnings: string[] = [];
  if (row.medianPeakMb > limit.maxPeakMb)
    failures.push(
      `${command} peak ${row.medianPeakMb.toFixed(1)} MB is over the ${limit.maxPeakMb} MB limit on ${platform}`,
    );
  if (row.medianMs > limit.ceilingMs)
    failures.push(
      `${command} median ${row.medianMs.toFixed(0)} ms is over the ${limit.ceilingMs} ms ceiling on ${platform}`,
    );
  if (baseRow === undefined) failures.push(where.baseMissing);
  else {
    const verdict = compareToBase(row.timesMs, baseRow.timesMs);
    if (!verdict.passed)
      failures.push(
        `${command} ${SCORE_LABEL} ${verdict.currentMs.toFixed(0)} ms is more than ${MAX_RATIO_TO_BASE} times the origin/main build's ${verdict.baseMs.toFixed(0)} ms in the same job on ${platform}`,
      );
  }
  return { failures, warnings };
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
