import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { stopCgroupScope } from "../../../src/adapters/process/cgroup-stop.ts";

test("a diagnostic snapshot failure cannot skip killing and confirming an owned cgroup", async () => {
  const calls: string[] = [];
  await assert.rejects(
    stopCgroupScope(
      {
        snapshot() {
          calls.push("snapshot");
          throw Error("subgroup disappeared");
        },
        kill() {
          calls.push("kill");
        },
        populated() {
          calls.push("empty");
          return false;
        },
        now: () => 0,
        pause: () => Promise.resolve(),
      },
      { cleanupTimeoutMs: 50, pollIntervalMs: 10 },
    ),
    /cgroup was stopped/,
  );
  expect(calls).toEqual(["snapshot", "kill", "empty"]);
}, 5000);

test("cgroup termination polls within the declared cleanup budget using an injected clock", async () => {
  let now = 0;
  const waits: number[] = [];
  await assert.rejects(
    stopCgroupScope(
      {
        snapshot: () => [1, 2],
        kill() {},
        populated: () => true,
        now: () => now,
        pause(ms) {
          waits.push(ms);
          now += ms;
          return Promise.resolve();
        },
      },
      { cleanupTimeoutMs: 23, pollIntervalMs: 10 },
    ),
    /remained populated/,
  );
  expect(waits).toEqual([10, 10, 3]);
}, 5000);
