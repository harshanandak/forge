import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { resolve } from "node:path";

setDefaultTimeout(30_000);
type Action = {
  lane: string;
  step: string;
  kind: string;
  why: string;
  ask?: string;
  raw?: string;
};
type Status = {
  enabled: boolean;
  stopped: boolean;
  hold?: string;
  load?: unknown;
  lanes: {
    id: string;
    stopped: boolean;
    calls: { used: number; limit: number };
    activeHours: { used: number; limit: number };
    hold?: string;
  }[];
};
type Handler<Output> = (call: {
  input: Record<string, unknown>;
  services: unknown;
  config?: unknown;
  signal: AbortSignal;
  deadline: number;
}) => Output | Promise<Output>;
type Operations = {
  "lane.next": Handler<Action | { actions: Action[] }>;
  "lane.stop": Handler<{ stopped: string }>;
  "lane.resume": Handler<{ resumed: string }>;
  "lane.status": Handler<Status>;
};
type Row = {
  key: string;
  revision: number;
  updatedAt: string;
  value: Record<string, unknown>;
};

const entry = resolve(
  import.meta.dirname,
  "../../../src/blocks/work/entry.cts",
);
const globals = globalThis as Record<string, unknown>;
const previousFail = globals.fail;
let operations: Operations;
beforeAll(() => {
  globals.fail = (code: string, message: string) => {
    throw new Error(`${code}: ${message}`);
  };
  delete require.cache[entry];
  operations = require(entry) as Operations;
});
afterAll(() => {
  if (previousFail === undefined) delete globals.fail;
  else globals.fail = previousFail;
});

function fixture(
  autopilot: Record<string, unknown> = {},
  lanes: Record<string, unknown> = {},
) {
  const config = { lanes: { ...lanes, autopilot } };
  const start = Date.parse("2026-01-01T00:00:00.000Z");
  const time = { now: start };
  const now = start;
  const records = new Map<string, Row>();
  const put = (
    key: string,
    value: Record<string, unknown>,
    options: { expectRevision: number },
  ) => {
    if ((records.get(key)?.revision ?? 0) !== options.expectRevision)
      throw new Error("REVISION_CONFLICT");
    const row = {
      key,
      value,
      revision: options.expectRevision + 1,
      updatedAt: new Date(now).toISOString(),
    };
    records.set(key, row);
    return row;
  };
  const ids = ["work-1", "work-2"];
  for (const id of ids)
    put(
      `issue:${id}`,
      {
        id,
        title: id,
        status: "open",
        labels: [],
        dependsOn: [],
        createdAt: new Date(now).toISOString(),
      },
      { expectRevision: 0 },
    );
  const state = {
    count: (prefix: string) =>
      [...records.keys()].filter((key) => key.startsWith(prefix)).length,
    maxNumber: () => 0,
    now: () => time.now,
    get: (key: string) => records.get(key),
    list: (prefix: string) =>
      [...records.values()].filter((row) => row.key.startsWith(prefix)),
    put,
    lease: () => undefined,
    acquire: () => undefined,
  };
  const registry = ids.map((id) => ({
    issue: id,
    issueId: id,
    worktree: `/lane/${id}`,
    branch: `feat/${id}`,
    brief: `/project/.worktrees/briefs/${id}.md`,
  }));
  const sample = {
    value: { freeMemoryMb: 8000, cpuBusyPercent: 10 },
    fail: false,
  };
  const ghCalls: string[][] = [];
  const services = {
    state,
    files: {
      root: "/project",
      read: (path: string) =>
        path === "forge-lanes.json" ? JSON.stringify(registry) : undefined,
    },
    environment: {
      platform: "linux",
      select: () => ({}),
      load: () =>
        sample.fail
          ? Promise.reject(new Error("Machine load could not be measured"))
          : Promise.resolve(sample.value),
    },
    process: {
      resolve: (path: string) => ({ kind: "resolved", path }),
      run: (_executable: unknown, args: string[]) => {
        ghCalls.push(args);
        return Promise.reject(new Error("guard must decide before GitHub"));
      },
    },
  };
  const bound = (input: Record<string, unknown>) => ({
    input,
    services,
    config,
    signal: new AbortController().signal,
    deadline: Number.MAX_SAFE_INTEGER,
  });
  return {
    records,
    registry,
    time,
    put,
    sample,
    ghCalls,
    call: (id: string, n: number) =>
      put(
        `comment:${id}:${n}`,
        { id, body: `call ${n} builder`, call: n },
        { expectRevision: 0 },
      ),
    next: async (input: Record<string, unknown>) =>
      await operations["lane.next"](bound(input)),
    all: async () =>
      (
        (await operations["lane.next"](bound({ all: true }))) as {
          actions: Action[];
        }
      ).actions,
    stop: (input: Record<string, unknown>) =>
      operations["lane.stop"](bound(input)),
    status: async () => await operations["lane.status"](bound({})),
  };
}

test("with the stop flag set, lane.next --all returns only pause for every lane", async () => {
  const f = fixture();
  await f.stop({ all: true });
  const actions = await f.all();
  expect(actions).toHaveLength(2);
  for (const action of actions) {
    expect(action.kind).toBe("pause");
    expect(action.why).toMatch(/stop/i);
  }
  expect(await f.next({ id: "work-1" })).toMatchObject({ kind: "pause" });
  expect(f.ghCalls).toHaveLength(0);
  expect((await f.status()).stopped).toBe(true);
});

test("a lane whose calls are used up pauses with an ask naming calls, limit and use", async () => {
  const f = fixture({ budgets: { calls: 3 } });
  for (const n of [1, 2, 3]) f.call("work-1", n);
  const action = (await f.next({ id: "work-1", pr: 7 })) as Action;
  expect(action.kind).toBe("pause");
  expect(action.ask).toMatch(/calls/);
  expect(action.ask).toContain("limit 3");
  expect(action.ask).toContain("used 3");
  expect(f.ghCalls).toHaveLength(0);
  const row = (await f.status()).lanes.find((lane) => lane.id === "work-1");
  expect(row?.calls).toEqual({ used: 3, limit: 3 });
});

test("the default call budget is 20", async () => {
  const f = fixture();
  expect((await f.status()).lanes[0]?.calls).toEqual({ used: 0, limit: 20 });
});

test("a load over the limit holds a new start and lane.status shows why", async () => {
  const f = fixture();
  expect((await f.status()).hold).toBeUndefined();
  f.sample.value = { freeMemoryMb: 500, cpuBusyPercent: 10 };
  expect((await f.status()).hold).toMatch(/^hold: .*free memory 500 MB/);
  f.sample.value = { freeMemoryMb: 8000, cpuBusyPercent: 97 };
  expect((await f.status()).hold).toMatch(/^hold: .*CPU 97%/);
  const tuned = fixture({ load: { minFreeMemoryMb: 100, maxCpuPercent: 99 } });
  tuned.sample.value = { freeMemoryMb: 500, cpuBusyPercent: 97 };
  expect((await tuned.status()).hold).toBeUndefined();
});

test("the project lane cap holds a new start", async () => {
  const f = fixture({}, { max: 2 });
  expect((await f.status()).hold).toMatch(/^hold: .*lane cap 2/);
  const roomy = fixture({}, { max: 3 });
  expect((await roomy.status()).hold).toBeUndefined();
});

test("lanes.autopilot.enabled false makes every lane.next pause", async () => {
  const f = fixture({ enabled: false });
  const actions = await f.all();
  expect(actions.map((action) => action.kind)).toEqual(["pause", "pause"]);
  expect(await f.next({ id: "work-2" })).toMatchObject({ kind: "pause" });
  expect((await f.status()).enabled).toBe(false);
  expect(f.ghCalls).toHaveLength(0);
});

test("a malformed global record pauses every lane instead of reading as no stop", async () => {
  for (const value of [
    {},
    { stopped: "x" },
    { stopped: { "work-1": "not a time" } },
    { stopped: {}, stopAll: 5 },
  ]) {
    const f = fixture();
    f.put("autopilot:global", value, { expectRevision: 0 });
    const actions = await f.all();
    expect(actions.map((action) => action.kind)).toEqual(["pause", "pause"]);
    for (const action of actions) expect(action.why).toMatch(/malformed/);
    expect(await f.next({ id: "work-1" })).toMatchObject({ kind: "pause" });
    const status = await f.status();
    expect(status.stopped).toBe(true);
    expect(status.hold).toMatch(/^hold: .*malformed/);
    expect(f.ghCalls).toHaveLength(0);
  }
});

test("a malformed clock or round record pauses the lane", async () => {
  for (const [key, value] of [
    ["autopilot-clock:work-1", { startedAt: "nope" }],
    ["autopilot-clock:work-1", {}],
    ["autopilot:work-1", { rounds: { review: "two" } }],
  ] as const) {
    const f = fixture();
    f.put(key, value, { expectRevision: 0 });
    const action = (await f.next({ id: "work-1", pr: 7 })) as Action;
    expect(action.kind).toBe("pause");
    expect(action.why).toMatch(/malformed/);
    expect(f.ghCalls).toHaveLength(0);
    expect((await f.status()).hold).toMatch(/^hold: .*malformed/);
  }
});

test("stop replaces an unreadable global record with a stop of every lane", async () => {
  const f = fixture();
  f.put("autopilot:global", { stopped: "x" }, { expectRevision: 0 });
  expect(await f.stop({ id: "work-1" })).toMatchObject({ stopped: "all" });
  expect((await f.status()).stopped).toBe(true);
});

test("an unmeasurable or out-of-range load sample holds a start", async () => {
  const f = fixture();
  f.sample.fail = true;
  expect((await f.status()).hold).toBe("hold: machine load cannot be measured");
  f.sample.fail = false;
  for (const value of [
    { freeMemoryMb: Number.NaN, cpuBusyPercent: 10 },
    { freeMemoryMb: 8000, cpuBusyPercent: Number.NaN },
    { freeMemoryMb: 8000, cpuBusyPercent: -1 },
    { freeMemoryMb: 8000, cpuBusyPercent: 101 },
    { freeMemoryMb: -5, cpuBusyPercent: 10 },
  ]) {
    f.sample.value = value;
    const status = await f.status();
    expect(status.hold).toBe("hold: machine load cannot be measured");
    expect(status.load).toBeUndefined();
  }
});

test("the active time budget compares exact milliseconds, not rounded hours", async () => {
  const f = fixture({ budgets: { activeHours: 1 } });
  await f.all();
  // 0.9997 hours rounds to 1.00 for display but is under the limit.
  f.time.now += 3_599_000;
  const under = await f.all();
  expect(under[0]?.why).not.toMatch(/active hours/);
  expect((await f.status()).lanes[0]?.activeHours).toEqual({
    used: 1,
    limit: 1,
  });
  f.time.now += 1_000;
  const over = (await f.all())[0];
  expect(over?.kind).toBe("pause");
  expect(over?.why).toMatch(/active hours budget/);
});

test("a lane past lane close with steps left stays listed until its journal is done", async () => {
  const f = fixture();
  // Lane close removed work-1 from the registry, but its tail is not finished.
  f.registry.splice(0, 1);
  const journal = {
    id: "work-1",
    pr: 7,
    url: "https://github.com/example/repo/pull/7",
    head: "a".repeat(40),
    mergeCommit: "b".repeat(40),
    branch: "feat/work-1",
    named: [],
    step: "issues",
    recorded: {},
    counters: { actions: 3, records: 2 },
  };
  f.put("autopilot:work-1", journal, { expectRevision: 0 });
  const lanes = (actions: Action[]) => actions.map((action) => action.lane);
  expect(lanes(await f.all()).toSorted()).toEqual(["work-1", "work-2"]);
  const status = await f.status();
  expect(status.lanes.map((lane) => lane.id).toSorted()).toEqual([
    "work-1",
    "work-2",
  ]);
  expect(status.lanes.find((lane) => lane.id === "work-1")).toMatchObject({
    step: "issues",
  });
  f.put(
    "autopilot:work-1",
    { ...journal, step: "done" },
    { expectRevision: 1 },
  );
  expect(lanes(await f.all())).toEqual(["work-2"]);
  expect((await f.status()).lanes.map((lane) => lane.id)).toEqual(["work-2"]);
});
