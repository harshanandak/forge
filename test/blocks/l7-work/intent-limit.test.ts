import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { resolve } from "node:path";

setDefaultTimeout(30_000);
type RecordValue = {
  id: string;
  parent?: string;
  body?: string;
  call?: number;
};
type Record = {
  key: string;
  revision: number;
  updatedAt: string;
  value: RecordValue;
};
type Handler = (call: {
  input: { id: string; role?: string; route?: string; body?: string };
  services: unknown;
  config?: unknown;
}) => {
  id: string;
  call: number;
  left: number;
  timeboxMinutes: number;
  stopBy: string;
};
let operations: { [op: string]: Handler };
const globals = globalThis as { [key: string]: unknown };
const previousFail = globals.fail;
beforeAll(() => {
  globals.fail = (code: string, message: string) => {
    throw new Error(`${code}: ${message}`);
  };
  operations = require(
    resolve(import.meta.dirname, "../../../src/blocks/work/entry.cts"),
  ) as typeof operations;
});
afterAll(() => {
  if (previousFail === undefined) delete globals.fail;
  else globals.fail = previousFail;
});

function project(stampDelay = 0) {
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  const records = new Map<string, Record>();
  const put = (
    key: string,
    value: RecordValue,
    options: { expectRevision: number },
  ) => {
    if ((records.get(key)?.revision ?? 0) !== options.expectRevision)
      throw new Error("REVISION_CONFLICT");
    const record = {
      key,
      value,
      revision: options.expectRevision + 1,
      updatedAt: new Date(now + stampDelay).toISOString(),
    };
    records.set(key, record);
    return record;
  };
  put("issue:work-1", { id: "work-1" }, { expectRevision: 0 });
  const state = {
    now: () => now,
    get: (key: string) => records.get(key),
    list: (prefix: string) =>
      [...records.values()].filter((r) => r.key.startsWith(prefix)).reverse(),
    put,
    lease: () => undefined,
    acquire: () => undefined,
  };
  const call = (id = "work-1", route?: string, view = state) =>
    operations["issue.call"]!({
      input: { id, role: "build", ...(route === undefined ? {} : { route }) },
      services: { state: view },
    });
  return {
    records,
    snapshotCall: () => {
      const snapshot = [...records.values()];
      return () =>
        call("work-1", undefined, {
          ...state,
          list: (prefix: string) =>
            snapshot.filter((r) => r.key.startsWith(prefix)),
        });
    },
    at: (hours: number) => {
      now = Date.parse("2026-01-01T00:00:00.000Z") + hours * 3600_000;
    },
    call,
    comment: (body: string) =>
      operations["issue.comment"]!({
        input: { id: "work-1", body },
        services: { state },
      }),
  };
}

test("issue.call is exported", () => {
  expect(typeof operations["issue.call"]).toBe("function");
});
test("60 calls are numbered; the 61st refuses without writing", () => {
  const p = project();
  for (let n = 1; n <= 60; n++)
    expect(p.call()).toMatchObject({
      call: n,
      left: 60 - n,
      timeboxMinutes: 45,
    });
  const before = [...p.records.values()];
  expect(() => p.call()).toThrow(/LIMIT_REACHED.*60 calls/);
  expect([...p.records.values()]).toEqual(before);
  expect(p.records.get("comment:work-1:60")?.value).toEqual({
    id: "work-1",
    body: "call 60 build",
    call: 60,
  });
});
test("a call at hour 29.5 gets 30 minutes and stopBy at hour 30 from the first store timestamp", () => {
  const p = project();
  p.comment("call 9 build");
  p.at(1);
  p.call();
  p.at(30.5);
  expect(p.call()).toMatchObject({
    call: 2,
    timeboxMinutes: 30,
    stopBy: "2026-01-02T07:00:00.000Z",
  });
});
test("the first stopBy uses the accepted store timestamp, even if the write takes time", () => {
  const p = project(1000);
  expect(p.call().stopBy).toBe("2026-01-02T06:00:01.000Z");
  p.at(29.5);
  expect(p.call().timeboxMinutes).toBe(30);
});
test("two callers reading the same snapshot cannot both record call n+1", () => {
  const p = project();
  p.call();
  const first = p.snapshotCall();
  const second = p.snapshotCall();
  expect(first()).toMatchObject({ call: 2 });
  expect(second).toThrow("REVISION_CONFLICT");
  expect(
    [...p.records.values()].filter((r) => r.value.call === 2),
  ).toHaveLength(1);
  expect(p.records.size).toBe(3);
});
test("missing issue names the id as typed", () => {
  expect(() => project().call("WORK-99")).toThrow(
    "Issue WORK-99 was not found",
  );
});
for (const hours of [30, 31, 29.99])
  test(`hour ${hours} refuses without writing`, () => {
    const p = project();
    p.call();
    p.at(hours);
    const before = [...p.records.values()];
    expect(() => p.call()).toThrow(/LIMIT_REACHED/);
    expect([...p.records.values()]).toEqual(before);
  });
test("slice and nested slice calls land on the intent; text cannot forge a call", () => {
  const p = project();
  p.records.set("issue:work-2", {
    key: "issue:work-2",
    revision: 1,
    updatedAt: "",
    value: { id: "work-2", parent: "work-1" },
  });
  p.records.set("issue:work-3", {
    key: "issue:work-3",
    revision: 1,
    updatedAt: "",
    value: { id: "work-3", parent: "work-2" },
  });
  p.comment("call 9 build");
  expect(p.call("work-3", "fast build")).toMatchObject({
    id: "work-1",
    call: 1,
  });
  expect(p.records.get("comment:work-1:2")?.value).toEqual({
    id: "work-1",
    body: "call 1 build fast build",
    call: 1,
  });
  expect(p.call("work-2").call).toBe(2);
});
test("a cyclic or missing parent refuses without a call record", () => {
  for (const parent of ["work-1", "work-2"]) {
    const p = project();
    p.records.get("issue:work-1")!.value.parent = parent;
    expect(() => p.call()).toThrow(
      parent === "work-1" ? /cycle/i : /NOT_FOUND/,
    );
    expect(p.records.size).toBe(1);
  }
});
