import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { killTree } from "../../../src/adapters/process/tree-kill.ts";

test("a descendant published after the first kill is signalled again before settlement", async () => {
  let now = 0;
  let kills = 0;
  let survivor = true;
  await killTree(
    123,
    { cleanupTimeoutMs: 30, pollIntervalMs: 10 },
    {
      signal(_pid, signal) {
        if (signal === "SIGKILL" && ++kills > 1) survivor = false;
        if (signal === 0 && !survivor)
          throw Object.assign(Error("gone"), { code: "ESRCH" });
      },
      now: () => now,
      pause(ms) {
        now += ms;
        return Promise.resolve();
      },
      processTable: {
        *members() {
          if (survivor) yield { pid: 125, state: "R" };
        },
      },
    },
  );
  expect(survivor).toBe(false);
  expect(kills).toBe(2);
}, 5000);

test("an empty snapshot cannot prove an existing group is empty", async () => {
  let now = 0;
  let kills = 0;
  let survivor = true;
  await killTree(
    123,
    { cleanupTimeoutMs: 30, pollIntervalMs: 10 },
    {
      signal(_pid, signal) {
        if (signal === "SIGKILL" && ++kills > 1) survivor = false;
        if (signal === 0 && !survivor)
          throw Object.assign(Error("gone"), { code: "ESRCH" });
      },
      now: () => now,
      pause(ms) {
        now += ms;
        return Promise.resolve();
      },
      processTable: {
        *members() {
          if (now > 0 && survivor) yield { pid: 125, state: "R" };
        },
      },
    },
  );
  expect(survivor).toBe(false);
  expect(kills).toBe(2);
}, 5000);

test("a persistently empty snapshot with a present group fails at the configured deadline", async () => {
  let now = 0;
  const waits: number[] = [];
  await assert.rejects(
    killTree(
      123,
      { cleanupTimeoutMs: 23, pollIntervalMs: 10 },
      {
        signal() {},
        now: () => now,
        pause(ms) {
          waits.push(ms);
          now += ms;
          return Promise.resolve();
        },
        processTable: { members: () => [] },
      },
    ),
    { code: "TREE_KILL_FAILED" },
  );
  expect(now).toBe(23);
  expect(waits).toEqual([10, 10, 3]);
}, 5000);

test("a zombie snapshot cannot hide a live descendant published before the probe", async () => {
  let now = 0;
  let kills = 0;
  let snapshots = 0;
  let descendant = false;
  await killTree(
    123,
    { cleanupTimeoutMs: 30, pollIntervalMs: 10 },
    {
      signal(_pid, signal) {
        // The retained zombie keeps every group probe successful.
        if (signal === "SIGKILL") {
          kills++;
          descendant = false;
        }
      },
      now: () => now,
      pause(ms) {
        now += ms;
        return Promise.resolve();
      },
      processTable: {
        *members() {
          yield { pid: 124, state: "Z" };
          if (descendant) yield { pid: 126, state: "R" };
          // The live descendant becomes visible only after the first enumeration.
          if (++snapshots === 1) descendant = true;
        },
      },
    },
  );
  expect(descendant).toBe(false);
  expect(kills).toBe(2);
}, 5000);
