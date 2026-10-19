import { expect, test } from "bun:test";
import {
  counterfactuals,
  packedCoverage,
  selectShard,
} from "../../node-fixtures/state/counterfactuals.ts";
import { firstSliceMutations } from "../../integration/counterfactuals.ts";
import { counterfactuals as workMutations } from "../../node-fixtures/work/counterfactuals.ts";
import { counterfactuals as memoryMutations } from "../../node-fixtures/memory/counterfactuals.ts";
import { asyncCounterfactuals } from "../../node-fixtures/async-handlers/counterfactuals.ts";

function verifyShards<T>(cases: readonly T[]): readonly T[] {
  const left = selectShard(cases, packedCoverage("24").shard);
  const right = selectShard(cases, packedCoverage("26").shard);
  const union = [...left, ...right];
  expect(union).toHaveLength(cases.length);
  expect(new Set(union).size).toBe(cases.length);
  expect(union.toSorted((a, b) => cases.indexOf(a) - cases.indexOf(b))).toEqual(
    [...cases],
  );
  expect(Math.abs(left.length - right.length)).toBeLessThanOrEqual(1);
  expect(new Set(cases.map((mutation) => JSON.stringify(mutation))).size).toBe(
    cases.length,
  );
  return union;
}

test("Node shards cover the full mutation list exactly once, including the timeout", () => {
  const union = verifyShards(counterfactuals);
  expect(union.filter((mutation) => mutation.kind === "timeout")).toHaveLength(
    1,
  );
}, 1000);

test("Node first-slice shards cover every mutation exactly once", () => {
  verifyShards(firstSliceMutations);
  expect(selectShard(firstSliceMutations, undefined)).toEqual(
    firstSliceMutations,
  );
}, 1000);

for (const { name, cases } of [
  { name: "work", cases: workMutations },
  { name: "memory", cases: memoryMutations },
  { name: "async Windows", cases: asyncCounterfactuals("win32") },
  { name: "async Linux", cases: asyncCounterfactuals("linux") },
  { name: "async macOS", cases: asyncCounterfactuals("darwin") },
] satisfies { name: string; cases: readonly unknown[] }[])
  test(`Node ${name} shards cover every mutation exactly once`, () => {
    verifyShards<unknown>(cases);
    expect(selectShard<unknown>(cases, undefined)).toEqual(cases);
  }, 1000);

test("shards stay complete and balanced as mutations are added", () => {
  for (
    let length = 0;
    length <=
    Math.max(
      counterfactuals.length,
      firstSliceMutations.length,
      workMutations.length,
      memoryMutations.length,
      asyncCounterfactuals("win32").length,
    ) +
      5;
    length++
  ) {
    const cases = Array.from({ length }, (_, index) => index);
    const left = selectShard(cases, 0);
    const right = selectShard(cases, 1);
    expect([...left, ...right].toSorted((a, b) => a - b)).toEqual(cases);
    expect(new Set([...left, ...right]).size).toBe(length);
    expect(Math.abs(left.length - right.length)).toBeLessThanOrEqual(1);
  }
}, 1000);

test("Bun runs on Node 24 only; standalone runs retain full coverage", () => {
  expect(packedCoverage("24")).toEqual({ bun: true, shard: 0 });
  expect(packedCoverage("26")).toEqual({ bun: false, shard: 1 });
  expect(packedCoverage(undefined)).toEqual({ bun: true, shard: undefined });
  expect(selectShard(counterfactuals, undefined)).toEqual(counterfactuals);
  for (const value of ["", "25", "0", "24.18.0", "26 "])
    expect(() => packedCoverage(value)).toThrow("STATE_NODE_LEG");
}, 1000);
