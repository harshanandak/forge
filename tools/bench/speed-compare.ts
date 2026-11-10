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

/** What the comparison is scored by, named in the failure message. */
export const SCORE_LABEL = "paired 25th percentile";

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
  const overCeiling = row.medianMs > limit.ceilingMs;
  const ceilingMessage = `${command} median ${row.medianMs.toFixed(0)} ms is over the ${limit.ceilingMs} ms ceiling on ${platform}`;
  if (baseRow === undefined) {
    if (overCeiling) failures.push(ceilingMessage);
    failures.push(where.baseMissing);
  } else {
    const verdict = compareToBase(row.timesMs, baseRow.timesMs);
    if (overCeiling) {
      // Runner speed does not cancel in an absolute time, so the ceiling fails the job only when
      // the same-job comparison with the base build fails too; otherwise it only warns.
      if (verdict.passed)
        warnings.push(
          `${ceilingMessage}, but the same-job origin/main build's median is ${baseRow.medianMs.toFixed(0)} ms and the comparison passed, so this is not failing`,
        );
      else failures.push(ceilingMessage);
    }
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
  if (current.length === 0 || current.length !== base.length)
    throw new Error("timings must contain the same nonzero number of pairs");
  // measurePair stores each side in run order, so index i on both sides belongs to pair i,
  // even when sampleOrder flips which side runs first. Form ratios before sorting any values.
  const pairs = current.map((currentMs, index) => {
    const baseMs = base[index]!;
    if (
      !Number.isFinite(currentMs) ||
      currentMs <= 0 ||
      !Number.isFinite(baseMs) ||
      baseMs <= 0
    )
      throw new Error("paired timings must be finite and positive");
    return { currentMs, baseMs, ratio: currentMs / baseMs };
  });
  pairs.sort((a, b) => a.ratio - b.ratio);
  // Shared runner drift cancels within each pair. Keep the fast-end rationale for recurring
  // load: the 3rd smallest of 9 ratios tolerates current-side spikes without letting one lucky
  // pair hide a regression. Report both timings from the pair that determines the verdict.
  const { currentMs, baseMs, ratio } =
    pairs[Math.floor((pairs.length - 1) / 4)]!;
  return { currentMs, baseMs, ratio, passed: !(currentMs > maxRatio * baseMs) };
}
