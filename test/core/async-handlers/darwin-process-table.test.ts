import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { killTree } from "../../../src/adapters/process/tree-kill.ts";
import {
  createDarwinProcessTable,
  MAX_DARWIN_GROUP_MEMBERS,
  type DarwinProcessApi,
} from "../../../src/adapters/process/darwin-process-table.ts";

function fakeApi(
  statuses: readonly { pid: number; state: number; groupId?: number }[],
): DarwinProcessApi {
  let error = 0;
  return {
    errno(value) {
      if (value !== undefined) error = value;
      return error;
    },
    listGroup(groupId, buffer, bytes) {
      expect(groupId).toBe(123);
      expect(bytes).toBe(buffer.length);
      for (const [index, member] of statuses.entries())
        buffer.writeInt32LE(member.pid, index * 4);
      return statuses.length;
    },
    pidInfo(pid, flavor, argument, buffer, bytes) {
      expect(flavor).toBe(13);
      expect(argument).toBe(0);
      expect(bytes).toBe(64);
      const member = statuses.find((item) => item.pid === pid);
      if (member === undefined) throw Error("Unexpected process");
      buffer.writeUInt32LE(pid, 0);
      buffer.writeUInt32LE(member.groupId ?? 123, 8);
      buffer.writeUInt32LE(member.state, 12);
      return 64;
    },
  };
}

function members(api: DarwinProcessApi) {
  return [...createDarwinProcessTable(() => api).members(123, () => {})];
}

test("Darwin preserves returned zombie and live states rather than trusting signal probes", () => {
  expect(
    members(
      fakeApi([
        { pid: 124, state: 5 },
        { pid: 125, state: 2 },
      ]),
    ),
  ).toEqual([
    { pid: 124, state: "Z" },
    { pid: 125, state: "R" },
  ]);
  expect(members(fakeApi([{ pid: 124, state: 5 }]))).toEqual([
    { pid: 124, state: "Z" },
  ]);
}, 5000);

test("Darwin reads group membership again to exclude a moved or reused PID", () => {
  expect(members(fakeApi([{ pid: 124, state: 2, groupId: 999 }]))).toEqual([]);
}, 5000);

test("Darwin accepts an empty group only when enumeration succeeded", () => {
  const api = fakeApi([]);
  api.errno(13);
  expect(members(api)).toEqual([]);
  api.listGroup = () => {
    api.errno(1);
    return 0;
  };
  expect(() => members(api)).toThrow(
    "Could not enumerate Darwin process group",
  );
}, 5000);

test("Darwin refuses a full or malformed PID list rather than hiding members", () => {
  const api = fakeApi([]);
  for (const count of [
    -1,
    0.5,
    MAX_DARWIN_GROUP_MEMBERS,
    MAX_DARWIN_GROUP_MEMBERS + 1,
  ]) {
    api.listGroup = () => count;
    expect(() => members(api)).toThrow();
  }
}, 5000);

test("Darwin skips a member reaped between enumeration and inspection", () => {
  const api = fakeApi([{ pid: 124, state: 5 }]);
  api.pidInfo = () => {
    api.errno(3);
    return 0;
  };
  expect(members(api)).toEqual([]);
}, 5000);

test("Darwin refuses permission, short records, invalid identities and unknown states", () => {
  const api = fakeApi([{ pid: 124, state: 5 }]);
  api.pidInfo = () => {
    api.errno(1);
    return 0;
  };
  expect(() => members(api)).toThrow("Could not inspect Darwin process");
  api.pidInfo = () => 16;
  expect(() => members(api)).toThrow("Invalid Darwin process record size");
  api.pidInfo = (_pid, _flavor, _argument, buffer) => {
    buffer.writeUInt32LE(999, 0);
    return 64;
  };
  expect(() => members(api)).toThrow("Invalid Darwin process identity");
  expect(() => members(fakeApi([{ pid: 124, state: 999 }]))).toThrow(
    "Invalid Darwin process state",
  );
}, 5000);

test("Darwin inspects state within the caller's remaining cleanup budget", () => {
  let checks = 0;
  const api = fakeApi([
    { pid: 124, state: 5 },
    { pid: 125, state: 2 },
  ]);
  const inspected: number[] = [];
  const original = api.pidInfo.bind(api);
  api.pidInfo = (...args) => {
    inspected.push(args[0]);
    return original(...args);
  };
  expect(() => [
    ...createDarwinProcessTable(() => api).members(123, () => {
      if (++checks === 5) throw Error("deadline reached");
    }),
  ]).toThrow("deadline reached");
  expect(inspected).toEqual([124]);
}, 5000);

test("Darwin does not load native bindings until a group is inspected", () => {
  let loaded = 0;
  const table = createDarwinProcessTable(() => {
    loaded++;
    return fakeApi([]);
  });
  const iterator = table.members(123, () => {});
  expect(loaded).toBe(0);
  expect([...iterator]).toEqual([]);
  expect(loaded).toBe(1);
}, 5000);

test("Darwin never acquires a retained zombie reference while confirming live membership", () => {
  const api = fakeApi([{ pid: 124, state: 5 }]);
  const argumentsSeen: number[] = [];
  api.pidInfo = (_pid, _flavor, argument) => {
    argumentsSeen.push(argument);
    // XNU's zombie-reference path can wait on P_LIST_WAITING without a timeout.
    // The live-only query excludes that zombie without taking its wait reference.
    if (argument !== 0) throw Error("Unbounded zombie-reference lookup");
    api.errno(3);
    return 0;
  };
  expect(members(api)).toEqual([]);
  expect(argumentsSeen).toEqual([0]);
}, 5000);

test("Darwin live-only inspection still refuses a live survivor at the cleanup deadline", async () => {
  let now = 0;
  const waits: number[] = [];
  const api = fakeApi([{ pid: 124, state: 2 }]);
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
        processTable: createDarwinProcessTable(() => api),
      },
    ),
    { code: "TREE_KILL_FAILED" },
  );
  expect(waits).toEqual([10, 10, 3]);
  expect(now).toBe(23);
}, 5000);
