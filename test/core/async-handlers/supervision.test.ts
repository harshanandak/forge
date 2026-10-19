import { expect, test } from "bun:test";
import { validateSupervision } from "../../../src/adapters/process/supervision.ts";

const declared = {
  cleanupTimeoutMs: 5000,
  pollIntervalMs: 25,
  drainTimeoutMs: 250,
  maxConcurrent: 1,
};

test("supervision needs declared policy and snapshots it", () => {
  expect(() => validateSupervision(undefined)).toThrow("Declare supervision");
  const config = { ...declared };
  const checked = validateSupervision(config);
  config.cleanupTimeoutMs = 1;
  expect(checked.cleanupTimeoutMs).toBe(5000);
  expect(Object.isFrozen(checked)).toBe(true);
}, 5000);

for (const [key, values] of Object.entries({
  cleanupTimeoutMs: [0, -1, 0.5, 60001, NaN, Infinity],
  pollIntervalMs: [0, -1, 0.5, 1001, NaN, Infinity],
  drainTimeoutMs: [-1, 0.5, 60001, NaN, Infinity],
  maxConcurrent: [-1, 0.5, 2, NaN, Infinity],
}))
  test(`${key} refuses values outside the safety range`, () => {
    for (const value of values)
      expect(() => validateSupervision({ ...declared, [key]: value })).toThrow(
        "Declare supervision",
      );
  }, 5000);

test("bounds admit the endpoints and polling cannot exceed the cleanup budget", () => {
  expect(() =>
    validateSupervision({
      cleanupTimeoutMs: 1,
      pollIntervalMs: 1,
      drainTimeoutMs: 0,
      maxConcurrent: 1,
    }),
  ).not.toThrow();
  expect(() =>
    validateSupervision({
      cleanupTimeoutMs: 60000,
      pollIntervalMs: 1000,
      drainTimeoutMs: 60000,
      maxConcurrent: 1,
    }),
  ).not.toThrow();
  expect(() =>
    validateSupervision({
      ...declared,
      cleanupTimeoutMs: 1,
      pollIntervalMs: 2,
    }),
  ).toThrow();
}, 5000);
