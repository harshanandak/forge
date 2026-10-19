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

test("a zombie-only group is terminated even while signal zero still succeeds", async () => {
  let now = 0;
  const waits: number[] = [];
  const control = {
    signal() {},
    now: () => now,
    pause(ms: number) {
      waits.push(ms);
      now += ms;
      return Promise.resolve();
    },
    processTable: {
      *members(groupId: number) {
        expect(groupId).toBe(123);
        yield { pid: 124, state: "Z" };
      },
    },
  };
  await killTree(123, { cleanupTimeoutMs: 23, pollIntervalMs: 10 }, control);
  expect(waits).toEqual([]);
}, 5000);

test("mixed live and zombie members are polled until only zombies remain", async () => {
  let now = 0;
  const waits: number[] = [];
  const control = {
    signal() {},
    now: () => now,
    pause(ms: number) {
      waits.push(ms);
      now += ms;
      return Promise.resolve();
    },
    processTable: {
      *members() {
        yield { pid: 124, state: "Z" };
        if (now < 20) yield { pid: 125, state: now === 0 ? "S" : "D" };
      },
    },
  };
  await killTree(123, { cleanupTimeoutMs: 23, pollIntervalMs: 10 }, control);
  expect(waits).toEqual([10, 10]);
}, 5000);

test("a real survivor still fails at the declared cleanup deadline", async () => {
  let now = 0;
  const waits: number[] = [];
  const control = {
    signal() {},
    now: () => now,
    pause(ms: number) {
      waits.push(ms);
      now += ms;
      return Promise.resolve();
    },
    processTable: {
      *members() {
        yield { pid: 124, state: "Z" };
        yield { pid: 125, state: "T" };
      },
    },
  };
  await assert.rejects(
    killTree(123, { cleanupTimeoutMs: 23, pollIntervalMs: 10 }, control),
    { code: "TREE_KILL_FAILED" },
  );
  expect(waits).toEqual([10, 10, 3]);
}, 5000);

test("an unreadable process table cannot confirm termination", async () => {
  let now = 0;
  const control = {
    signal() {},
    now: () => now,
    pause(ms: number) {
      now += ms;
      return Promise.resolve();
    },
    processTable: {
      members(): Iterable<{ pid: number; state: string }> {
        throw Object.assign(Error("permission"), { code: "EACCES" });
      },
    },
  };
  await assert.rejects(
    killTree(123, { cleanupTimeoutMs: 23, pollIntervalMs: 10 }, control),
    {
      code: "TREE_KILL_FAILED",
      message: "Could not inspect process group members",
    },
  );
}, 5000);

test("process-table enumeration shares the declared cleanup budget", async () => {
  let now = 0;
  let closed = false;
  const control = {
    signal() {},
    now: () => now,
    pause: () => Promise.resolve(),
    processTable: {
      *members() {
        try {
          yield { pid: 124, state: "Z" };
          now = 23;
          yield { pid: 125, state: "Z" };
        } finally {
          closed = true;
        }
      },
    },
  };
  await assert.rejects(
    killTree(123, { cleanupTimeoutMs: 23, pollIntervalMs: 10 }, control),
    { code: "TREE_KILL_FAILED" },
  );
  expect(closed).toBe(true);
}, 5000);

test("an initial permission response needs member-state proof even for zombie-only groups", async () => {
  const control = {
    signal() {
      throw Object.assign(Error("probe"), { code: "EPERM" });
    },
    now: () => 0,
    pause: () => Promise.resolve(),
    processTable: {
      *members() {
        yield { pid: 124, state: "Z" };
      },
    },
  };
  await killTree(123, { cleanupTimeoutMs: 23, pollIntervalMs: 10 }, control);
}, 5000);
