import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { runBounded } from "../../../tools/packed-pool.ts";
import { packedSuites } from "../../../tools/pack-smoke/suites.ts";

test("packed pool caps concurrent work, keeps output order and drains failures", async () => {
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

test("packed pool rejects invalid limits without starting work", async () => {
  for (const limit of [0, -1, 1.5, 4, Infinity]) {
    let started = false;
    const result = await Promise.allSettled([
      runBounded([1], limit, () => {
        started = true;
        return Promise.resolve();
      }),
    ]);
    expect(result[0].status).toBe("rejected");
    expect(started).toBe(false);
  }
  expect(await runBounded([], 2, () => Promise.resolve(0))).toEqual([]);
}, 1000);

test("every packed suite is registered exactly once for the shared install", () => {
  const root = resolve(import.meta.dirname, "../../..");
  function files(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory()
        ? files(path)
        : entry.name === "packed.integration.test.ts"
          ? [relative(root, path).replaceAll("\\", "/")]
          : [];
    });
  }
  const registered: string[] = packedSuites.map((suite) => suite.file);
  expect(registered.toSorted()).toEqual(files(join(root, "test")).toSorted());
  expect(new Set(packedSuites.map((suite) => suite.file)).size).toBe(
    packedSuites.length,
  );
  expect(new Set(packedSuites.map((suite) => suite.consumerEnv)).size).toBe(
    packedSuites.length,
  );
}, 1000);
