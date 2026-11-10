import { expect, test } from "bun:test";
import {
  MAX_RATIO_TO_BASE,
  compareToBase,
  gateDecision,
  sampleOrder,
  type GateRow,
  type Side,
} from "../../tools/bench/speed-compare.ts";

const PAIRS = 9;
const BASE_MS = 300;

/**
 * Timings for one speed run with injected load: `ms(side, runIndex)` is the time of the run that
 * happened at that position in the job. Returns each build's times in the order they were taken.
 */
function simulate(ms: (side: Side, index: number) => number): {
  current: number[];
  base: number[];
} {
  const current: number[] = [];
  const base: number[] = [];
  sampleOrder(PAIRS).forEach((side, index) =>
    (side === "current" ? current : base).push(ms(side, index)),
  );
  return { current, base };
}

// The statistic the gate used before: the ratio of the two builds' plain medians.
const plainMedian = (times: readonly number[]): number =>
  [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)]!;
const ratioOfMedians = (current: number[], base: number[]): number =>
  plainMedian(current) / plainMedian(base);

// Both builds cost the same. A load that repeats every fourth run adds 15 percent to the run it
// lands on. The alternating pair order repeats every four runs, so every fourth run is the current
// build's: five of its nine runs are slowed and none of the base build's, which moves the plain
// median by the whole 15 percent although nothing in the build changed.
const recurringLoad = (_side: Side, index: number): number =>
  BASE_MS * (index % 4 === 0 ? 1.15 : 1);

test("the alternating order hands a recurring load to the same build every time", () => {
  const sides = sampleOrder(PAIRS);
  expect(sides.slice(0, 4)).toEqual(["current", "base", "base", "current"]);
  const hit = sides.filter((_, index) => index % 4 === 0);
  expect(new Set(hit)).toEqual(new Set(["current"]));
}, 1000);

test("identical builds under recurring load: the old plain-median ratio fails, the gate passes", () => {
  const { current, base } = simulate(recurringLoad);
  expect(ratioOfMedians(current, base)).toBeGreaterThan(MAX_RATIO_TO_BASE);
  const verdict = compareToBase(current, base);
  expect(verdict.ratio).toBeLessThanOrEqual(MAX_RATIO_TO_BASE);
  expect(verdict.passed).toBe(true);
}, 1000);

test("identical builds with no load pass", () => {
  const { current, base } = simulate(() => BASE_MS);
  expect(compareToBase(current, base).passed).toBe(true);
}, 1000);

test("a real 10 percent slowdown with no load fails at 1.05", () => {
  const { current, base } = simulate((side) =>
    side === "current" ? BASE_MS * 1.1 : BASE_MS,
  );
  const verdict = compareToBase(current, base);
  expect(verdict.passed).toBe(false);
  expect(verdict.ratio).toBeCloseTo(1.1, 5);
}, 1000);

test("a real 10 percent slowdown still fails when the recurring load is present", () => {
  const { current, base } = simulate(
    (side, index) =>
      recurringLoad(side, index) * (side === "current" ? 1.1 : 1),
  );
  expect(compareToBase(current, base).passed).toBe(false);
}, 1000);

test("a build exactly at the limit passes and one just over fails", () => {
  const at = simulate((side) =>
    side === "current" ? BASE_MS * 1.05 : BASE_MS,
  );
  expect(compareToBase(at.current, at.base).passed).toBe(true);
  const over = simulate((side) =>
    side === "current" ? BASE_MS * 1.06 : BASE_MS,
  );
  expect(compareToBase(over.current, over.base).passed).toBe(false);
}, 1000);

// The gate's whole decision. The ceiling is 500 ms and the memory cap 70 MB, as on win32.
const LIMIT = { ceilingMs: 500, maxPeakMb: 70 };
const WHERE = {
  command: "issue show",
  platform: "win32",
  baseMissing: "the origin/main build was not found",
};
const row = (ms: number, peakMb = 50): GateRow => ({
  medianMs: ms,
  medianPeakMb: peakMb,
  timesMs: Array.from({ length: PAIRS }, () => ms),
});

test("over the ceiling while the base comparison passes: a warning, no failure", () => {
  const { failures, warnings } = gateDecision(LIMIT, row(518), row(510), WHERE);
  expect(failures).toEqual([]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("518 ms");
  expect(warnings[0]).toContain("500 ms");
  expect(warnings[0]).toContain("510 ms");
}, 1000);

test("over the ceiling while the base comparison fails: both are failures", () => {
  const { failures, warnings } = gateDecision(LIMIT, row(600), row(500), WHERE);
  expect(warnings).toEqual([]);
  expect(failures).toHaveLength(2);
  expect(failures[0]).toContain("ceiling");
  expect(failures[1]).toContain("times the origin/main build");
}, 1000);

test("a missing base build fails, even under the ceiling", () => {
  const { failures } = gateDecision(LIMIT, row(300), undefined, WHERE);
  expect(failures).toEqual([WHERE.baseMissing]);
}, 1000);

test("over the memory cap fails whether or not the base comparison passes", () => {
  const withBase = gateDecision(LIMIT, row(300, 71), row(300), WHERE);
  expect(withBase.failures).toHaveLength(1);
  expect(withBase.failures[0]).toContain("MB");
  const noBase = gateDecision(LIMIT, row(300, 71), undefined, WHERE);
  expect(noBase.failures).toHaveLength(2);
}, 1000);

test("under every limit and level with the base build: pass with no warning", () => {
  expect(gateDecision(LIMIT, row(300), row(300), WHERE)).toEqual({
    failures: [],
    warnings: [],
  });
}, 1000);

// Synthetic PR 399 shape, not recovered raw timings: the independent scores are 561/534,
// but five pairs are level or faster. The medians also match the reported 573/575 ms.
const runnerNoise = {
  current: [561, 561, 561, 573, 573, 590, 610, 630, 650],
  base: [520, 528, 534, 560, 575, 590, 610, 630, 650],
};

test("PR 399 shaped noise passes using the paired 25th percentile", () => {
  const { current, base } = runnerNoise;
  const independentQuartile = (times: number[]): number =>
    [...times].sort((a, b) => a - b)[2]!;
  expect(independentQuartile(current) / independentQuartile(base)).toBeCloseTo(
    1.0506,
    4,
  );
  const verdict = compareToBase(current, base);
  expect(verdict.ratio).toBeCloseTo(1, 5);
  expect(verdict.passed).toBe(true);
}, 1000);

test("PR 399 shaped noise above the ceiling only warns", () => {
  const { failures, warnings } = gateDecision(
    LIMIT,
    { ...row(573), timesMs: runnerNoise.current },
    { ...row(575), timesMs: runnerNoise.base },
    WHERE,
  );
  expect(failures).toEqual([]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("573 ms");
  expect(warnings[0]).toContain("575 ms");
}, 1000);

test("a monotone runner slowdown shared by each pair cancels", () => {
  const { current, base } = simulate(
    (_side, index) => BASE_MS * (1 + Math.floor(index / 2) * 0.1),
  );
  const verdict = compareToBase(current, base);
  expect(verdict.ratio).toBeCloseTo(1, 5);
  expect(verdict.passed).toBe(true);
}, 1000);

test("a real 7 percent slowdown fails with shared runner drift", () => {
  const { current, base } = simulate(
    (side, index) =>
      BASE_MS *
      (1 + Math.floor(index / 2) * 0.1) *
      (side === "current" ? 1.07 : 1),
  );
  const verdict = compareToBase(current, base);
  expect(verdict.ratio).toBeCloseTo(1.07, 5);
  expect(verdict.passed).toBe(false);
}, 1000);

test("a real 5.5 percent slowdown with no drift fails", () => {
  const { current, base } = simulate(
    (side) => BASE_MS * (side === "current" ? 1.055 : 1),
  );
  const verdict = compareToBase(current, base);
  expect(verdict.ratio).toBeCloseTo(1.055, 5);
  expect(verdict.passed).toBe(false);
}, 1000);

test("the failure message names the paired estimator and both timings", () => {
  const { failures } = gateDecision(LIMIT, row(321), row(300), WHERE);
  expect(failures).toHaveLength(1);
  expect(failures[0]).toContain("paired 25th percentile");
  expect(failures[0]).toContain("321 ms");
  expect(failures[0]).toContain("300 ms");
}, 1000);
