import { expect, test } from "bun:test";
import {
  MAX_RATIO_TO_BASE,
  compareToBase,
  gateDecision,
  medianPairedDelta,
  sampleOrder,
  type GateRow,
  type Side,
} from "../../tools/bench/speed-compare.ts";
import {
  recordSpeedSample,
  type SpeedSample,
} from "../../tools/bench/speed-samples.ts";

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
  baseMissing:
    "Speed memory comparison incomplete: the base build was not found.",
};
const row = (ms: number, peakMb = 50): GateRow => ({
  medianMs: ms,
  medianPeakMb: peakMb,
  timesMs: Array.from({ length: PAIRS }, () => ms),
  peaksMb: Array.from({ length: PAIRS }, () => peakMb),
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

test("over the memory cap warns and the missing base still fails", () => {
  const { failures, warnings, memory } = gateDecision(
    LIMIT,
    row(300, 71),
    undefined,
    WHERE,
  );
  expect(failures).toEqual([WHERE.baseMissing]);
  expect(warnings).toEqual([
    "issue show peak 71.0 MB is over the 70 MB limit on win32",
  ]);
  expect(memory).toBeUndefined();
}, 1000);

test("under every limit and level with the base build: pass with no warning", () => {
  expect(gateDecision(LIMIT, row(300), row(300), WHERE)).toEqual({
    failures: [],
    warnings: [],
    memory: {
      baseMedianPeakMb: 50,
      headMedianPeakMb: 50,
      changePercent: 0,
      absoluteCapMb: 70,
      status: "pass",
    },
  });
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

test("Speed sample output keeps acquisition order and one-based positions", () => {
  const samples: SpeedSample[] = [];
  const times = [30, 10, 50, 20];
  sampleOrder(2).forEach((side, index) =>
    recordSpeedSample(samples, side, times[index]!),
  );
  expect(samples).toEqual([
    { side: "current", position: 1, ms: 30 },
    { side: "base", position: 2, ms: 10 },
    { side: "base", position: 3, ms: 50 },
    { side: "current", position: 4, ms: 20 },
  ]);
}, 1000);

const LINUX = { ceilingMs: 350, maxPeakMb: 85 };
const LINUX_WHERE = { ...WHERE, platform: "linux" };
const peakRow = (values: readonly number[], medianPeakMb: number): GateRow => ({
  ...row(300, 0),
  medianPeakMb,
  peaksMb: values,
});

test("the paired difference pairs run i of one build with run i of the other", () => {
  expect(medianPairedDelta([5, 1, 9], [4, 3, 2])).toBe(1);
  expect(() => medianPairedDelta([1, 2], [1])).toThrow();
}, 1000);

test("85.1 MB against an 84 MB base on main warns and passes", () => {
  const { failures, warnings } = gateDecision(
    LINUX,
    row(300, 85.1),
    row(300, 84),
    LINUX_WHERE,
  );
  expect(failures).toEqual([]);
  expect(warnings).toEqual([
    "issue show peak 85.1 MB is over the 85 MB limit on linux",
  ]);
}, 1000);

test.each([
  [54.95, 9.9, "pass", 0, 0],
  [55, 10, "pass", 0, 0],
  [55.05, 10.1, "warning", 1, 0],
  [57.5, 15, "warning", 1, 0],
  [59.95, 19.9, "warning", 1, 0],
  [60, 20, "warning", 1, 0],
  [60.05, 20.1, "failure", 0, 1],
  [62.5, 25, "failure", 0, 1],
] as const)(
  "%p MB against a 50 MB base gives %p percent growth and a %s",
  (headPeak, growth, status, warningCount, failureCount) => {
    const { failures, warnings, memory } = gateDecision(
      LINUX,
      row(300, headPeak),
      row(300),
      LINUX_WHERE,
    );
    expect(memory?.changePercent).toBeCloseTo(growth, 8);
    expect(memory?.status).toBe(status);
    expect(warnings).toHaveLength(warningCount);
    expect(failures).toHaveLength(failureCount);
    const annotation = [...failures, ...warnings][0];
    if (annotation) expect(annotation).toContain(`${growth.toFixed(1)}% over`);
  },
  1000,
);

test("the Windows cap warns at 70 MB while the relative check passes", () => {
  const { failures, warnings } = gateDecision(
    LIMIT,
    row(300, 71.5),
    row(300, 69.5),
    WHERE,
  );
  expect(failures).toEqual([]);
  expect(warnings).toEqual([
    "issue show peak 71.5 MB is over the 70 MB limit on win32",
  ]);
}, 1000);

test("the absolute warning appears alongside a relative failure", () => {
  const { failures, warnings, memory } = gateDecision(
    LINUX,
    row(300, 100),
    row(300, 80),
    LINUX_WHERE,
  );
  expect(failures).toHaveLength(1);
  expect(failures[0]).toContain("more than the 20% limit");
  expect(warnings).toEqual([
    "issue show peak 100.0 MB is over the 85 MB limit on linux",
  ]);
  expect(memory?.status).toBe("failure");
}, 1000);

test("the recorded identical-build cap crossing warns without a peak failure", () => {
  // Hosted job 132732994703: the 1.32 MB paired gap tripped the former 0.5 MB crossing margin.
  const current = peakRow(
    [
      85.55859375, 86.1640625, 85.13671875, 86.140625, 87.4609375, 83.5234375,
      83.2734375, 82.39453125, 84.84765625, 86.33984375, 86.80078125,
      85.66015625, 87.05859375, 87.4921875, 86.98046875,
    ],
    86.140625,
  );
  const base = peakRow(
    [
      83.99609375, 84.1953125, 82.546875, 84.08203125, 83.0546875, 83.40625,
      82.30078125, 83.28125, 86.546875, 86.70703125, 88.0625, 84, 86.85546875,
      85.5234375, 85.66015625,
    ],
    84.08203125,
  );
  expect(medianPairedDelta(current.peaksMb, base.peaksMb)).toBe(1.3203125);
  const { failures, warnings } = gateDecision(
    LINUX,
    current,
    base,
    LINUX_WHERE,
  );
  expect(failures).toEqual([]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("85 MB");
}, 1000);
