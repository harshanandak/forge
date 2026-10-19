import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { killTree } from "../../../src/adapters/process/tree-kill.ts";

test("an ambiguous group probe polls until absence, never treating permission as termination", async () => {
  let now = 0;
  let probes = 0;
  const waits: number[] = [];
  await killTree(
    123,
    { cleanupTimeoutMs: 30, pollIntervalMs: 10 },
    {
      signal(pid, signal) {
        expect(pid).toBe(-123);
        if (signal === 0)
          throw Object.assign(Error("probe"), {
            code: ++probes < 3 ? "EPERM" : "ESRCH",
          });
      },
      now: () => now,
      pause(ms) {
        waits.push(ms);
        now += ms;
        return Promise.resolve();
      },
    },
  );
  expect(waits).toEqual([10, 10]);
}, 5000);

test("a group whose absence cannot be confirmed fails at its declared deadline", async () => {
  let now = 0;
  const waits: number[] = [];
  await assert.rejects(
    killTree(
      123,
      { cleanupTimeoutMs: 23, pollIntervalMs: 10 },
      {
        signal(_pid, signal) {
          if (signal === 0)
            throw Object.assign(Error("probe"), { code: "EPERM" });
        },
        now: () => now,
        pause(ms) {
          waits.push(ms);
          now += ms;
          return Promise.resolve();
        },
      },
    ),
    { code: "TREE_KILL_FAILED" },
  );
  expect(waits).toEqual([10, 10, 3]);
}, 5000);
