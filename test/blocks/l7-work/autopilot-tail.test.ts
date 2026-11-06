import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { resolve } from "node:path";

setDefaultTimeout(30_000);
type Action = {
  lane: string;
  step: string;
  n: number;
  kind: string;
  why: string;
  expect: string;
  argv?: string[];
  ask?: string;
  raw?: string;
};
type Handler<Output> = (call: {
  input: Record<string, unknown>;
  services: unknown;
  config?: unknown;
  signal: AbortSignal;
  deadline: number;
}) => Output | Promise<Output>;
type Operations = {
  "lane.next": Handler<Action>;
  "lane.record": Handler<{ step: string; n: number; recorded: boolean }>;
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
const load = (): Operations => {
  delete require.cache[entry];
  return require(entry) as Operations;
};
beforeAll(() => {
  globals.fail = (code: string, message: string) => {
    throw new Error(`${code}: ${message}`);
  };
  operations = load();
});
afterAll(() => {
  if (previousFail === undefined) delete globals.fail;
  else globals.fail = previousFail;
});

const head = "a".repeat(40),
  merge = "b".repeat(40),
  moved = "c".repeat(40);
const url = "https://github.com/example/repo/pull/7";
const config = {
  lanes: {
    autopilot: {
      receiptChecks: ["typecheck"],
      rebuild: { argv: ["bun", "run", "build"] },
    },
  },
};

function fixture() {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
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
  const issue = (id: string) =>
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
  for (const id of ["work-1", "work-2", "work-3"]) issue(id);
  put(
    "link:work-2:1",
    { id: "work-2", relation: "delivers", url },
    { expectRevision: 0 },
  );
  const close = (id: string, receipt: string) => {
    const row = records.get(`issue:${id}`)!;
    put(
      `issue:${id}`,
      { ...row.value, status: "closed", receipt },
      { expectRevision: row.revision },
    );
  };
  const state = {
    count: (prefix: string) =>
      [...records.keys()].filter((key) => key.startsWith(prefix)).length,
    maxNumber: () => 0,
    now: () => now,
    get: (key: string) => records.get(key),
    list: (prefix: string) =>
      [...records.values()].filter((row) => row.key.startsWith(prefix)),
    put,
    lease: () => undefined,
  };
  const lane = {
    issue: "work-1",
    issueId: "work-1",
    worktree: "/lane",
    branch: "feat/x",
    brief: "/project/.worktrees/briefs/work-1.md",
  };
  const files = new Map<string, string>([
    ["forge-lanes.json", JSON.stringify([lane])],
    [".worktrees/briefs/work-1.md", "Goal\nCloses: work-3\n"],
  ]);
  const gh = {
    reply: {
      state: "MERGED",
      headRefName: "feat/x",
      headRefOid: head,
      mergeCommit: { oid: merge },
      url,
    } as Record<string, unknown> | string,
    calls: 0,
  };
  const receipts = new Map([
    ["r1", { id: "r1", status: "PASS", subject: merge }],
    ["stale", { id: "stale", status: "PASS", subject: head }],
  ]);
  const services = {
    state,
    receipts: { get: (id: string) => receipts.get(id) },
    files: {
      root: "/project",
      read: (path: string) => files.get(path),
    },
    environment: { select: () => ({}) },
    process: {
      resolve: (path: string) => ({ kind: "resolved", path }),
      run: () => {
        gh.calls++;
        return Promise.resolve({
          stdout:
            typeof gh.reply === "string" ? gh.reply : JSON.stringify(gh.reply),
          stderr: "",
          exitCode: 0,
          timedOut: false,
          truncated: false,
        });
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
    files,
    gh,
    close,
    next: async (input: Record<string, unknown> = {}, ops = operations) =>
      await ops["lane.next"](bound({ id: "work-1", pr: 7, ...input })),
    record: async (action: number, result: unknown, ops = operations) =>
      await ops["lane.record"](
        bound({ id: "work-1", action, result: JSON.stringify(result) }),
      ),
    removeLane: () => files.set("forge-lanes.json", "[]"),
  };
}

test("lane.next and lane.record are exported", () => {
  expect(typeof operations["lane.next"]).toBe("function");
  expect(typeof operations["lane.record"]).toBe("function");
});

test("repeated lane.next and lane.record walk receipt, close, issues, rebuild, unwatch, done", async () => {
  const f = fixture();
  const seen: Action[] = [];
  const step = async () => {
    const action = await f.next();
    seen.push(action);
    return action;
  };
  let action = await step();
  expect(action).toMatchObject({ step: "receipt", n: 1, kind: "forge" });
  expect(action.argv).toEqual([
    "forge",
    "check",
    "run",
    "--input",
    JSON.stringify({ checks: ["typecheck"] }),
  ]);
  expect(await f.next()).toEqual(action);
  await f.record(1, { receipt: "r1" });
  action = await step();
  expect(action).toMatchObject({ step: "close", n: 2, kind: "forge" });
  expect(action.argv?.slice(0, 3)).toEqual(["forge", "lane", "close"]);
  f.close("work-1", "r1");
  f.removeLane();
  action = await step();
  expect(action).toMatchObject({ step: "issues", n: 3 });
  expect(action.argv?.slice(0, 3)).toEqual(["forge", "issue", "close"]);
  expect(action.argv).toContain("work-2");
  f.close("work-2", "r1");
  action = await step();
  expect(action.argv).toContain("work-3");
  f.close("work-3", "r1");
  action = await step();
  expect(action).toMatchObject({ step: "rebuild", kind: "run" });
  expect(action.argv).toEqual(["bun", "run", "build"]);
  expect(action.expect).toBe("recorded, not verified");
  await f.record(action.n, { exitCode: 0 });
  action = await step();
  expect(action).toMatchObject({ step: "unwatch", kind: "harness" });
  expect(action.expect).toBe("recorded, not verified");
  await f.record(action.n, { done: true });
  action = await step();
  expect(action).toMatchObject({ step: "done", kind: "done" });
  const order = seen
    .map((row) => row.step)
    .filter((name, index, all) => name !== all[index - 1]);
  expect(order).toEqual([
    "receipt",
    "close",
    "issues",
    "rebuild",
    "unwatch",
    "done",
  ]);
  const log = [...f.records.keys()].filter((key) =>
    key.startsWith("autopilot-event:work-1:"),
  );
  expect(log.length).toBeGreaterThan(5);
  expect(f.records.has("autopilot:work-1")).toBe(true);
});

test("a fresh process with the same store resumes at the same step", async () => {
  const f = fixture();
  await f.next();
  await f.record(1, { receipt: "r1" });
  const before = await f.next();
  expect(before).toMatchObject({ step: "close", n: 2 });
  const fresh = load();
  expect(await f.next({}, fresh)).toEqual(before);
  f.close("work-1", "r1");
  f.removeLane();
  expect(await f.next({}, fresh)).toMatchObject({ step: "issues", n: 3 });
});

test("a readback head that differs from the journal pauses with an ask", async () => {
  const f = fixture();
  await f.next();
  f.gh.reply = { ...(f.gh.reply as object), headRefOid: moved };
  const action = await f.next();
  expect(action.kind).toBe("pause");
  expect(action.ask).toBeTruthy();
  expect(action.raw).toContain(head);
  expect(action.raw).toContain(moved);
});

test("a head pin that differs from GitHub pauses before anything is journaled", async () => {
  const f = fixture();
  const action = await f.next({ head: moved });
  expect(action.kind).toBe("pause");
  expect(action.raw).toContain(moved);
  expect(action.raw).toContain(head);
  expect(f.records.has("autopilot:work-1")).toBe(false);
});

test("a receipt at another commit pauses and quotes the receipt", async () => {
  const f = fixture();
  await f.next();
  await f.record(1, { receipt: "stale" });
  const action = await f.next();
  expect(action.kind).toBe("pause");
  expect(action.raw).toContain(head);
});

test("unreadable GitHub data pauses and quotes it; an open PR waits", async () => {
  const f = fixture();
  f.gh.reply = "not json";
  const garbled = await f.next();
  expect(garbled).toMatchObject({ kind: "pause", raw: "not json" });
  f.gh.reply = {
    state: "OPEN",
    headRefName: "feat/x",
    headRefOid: head,
    mergeCommit: null,
    url,
  };
  expect(await f.next()).toMatchObject({ kind: "wait" });
});

test("recording an action that is not open is refused", async () => {
  const f = fixture();
  await f.next();
  await expect(f.record(9, { receipt: "r1" })).rejects.toThrow(
    /INPUT_CONFLICT/,
  );
});
