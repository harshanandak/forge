import { expect, test } from "bun:test";
import { runBounded } from "./run.ts";

test("bounded fixtures cap concurrent work, keep output order and drain failures", async () => {
  let active = 0;
  let peak = 0;
  const finished: number[] = [];
  let release: (() => void) | undefined;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const pending = runBounded([0, 1, 2, 3], 2, async (index) => {
    active++;
    peak = Math.max(peak, active);
    if (index < 2) {
      if (active === 2) release!();
      await gate;
    }
    await Promise.resolve();
    active--;
    finished.push(index);
    return index;
  });
  expect(await pending).toEqual([0, 1, 2, 3]);
  expect(peak).toBe(2);
  expect(active).toBe(0);
  expect(finished.toSorted()).toEqual([0, 1, 2, 3]);
  const failureFinished: number[] = [];
  let caught: unknown;
  try {
    await runBounded([0, 1, 2], 2, async (index) => {
      await Promise.resolve();
      failureFinished.push(index);
      if (index !== 1) throw new Error(`failure ${index}`);
      return index;
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AggregateError);
  expect((caught as AggregateError).errors).toHaveLength(2);
  expect(failureFinished.toSorted()).toEqual([0, 1, 2]);
}, 1000);
