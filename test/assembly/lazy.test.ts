import { expect, test } from "bun:test";
import { lazy } from "../../src/assembly/lazy.ts";

test("lazy loads once and shares the result", async () => {
  let loads = 0;
  const load = lazy(() => {
    loads += 1;
    return Promise.resolve({ value: loads });
  });
  const [first, second] = await Promise.all([load(), load()]);
  expect(first).toBe(second);
  expect(loads).toBe(1);
}, 5_000);

test("lazy tries again after a failed load", async () => {
  let loads = 0;
  const load = lazy(() => {
    loads += 1;
    return loads === 1
      ? Promise.reject(new Error("first load fails"))
      : Promise.resolve("loaded");
  });
  await expect(load()).rejects.toThrow("first load fails");
  expect(await load()).toBe("loaded");
  expect(loads).toBe(2);
}, 5_000);
