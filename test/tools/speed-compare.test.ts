import { expect, test } from "bun:test";
import {
  MAX_RATIO_TO_BASE,
  compareToBase,
  sampleOrder,
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
