import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import { StateOwner } from "../../../src/core/state/index.ts";
import { RecordFamilyRegistry } from "../../../src/core/state/families.ts";
import { createStateClient } from "../../../src/assembly/state-client.ts";
import { LocalState } from "../../../src/assembly/state.ts";
import { workFamilyPolicy } from "../../../src/blocks/work/state-families.ts";
import { refuse } from "../../../src/core/trust/index.ts";
import type { HandlerCall } from "../../../src/contract/author.ts";

setDefaultTimeout(30_000);
const globals = globalThis as Record<string, unknown>,
  prior = globals.fail;
beforeAll(() => {
  globals.fail = refuse;
});
afterAll(() => {
  if (prior === undefined) delete globals.fail;
  else globals.fail = prior;
});
const operations = require("../../../src/blocks/work/entry.cts") as Record<
  string,
  (call: HandlerCall<Record<string, unknown>>) => unknown
>;
const namespace = "forge/work",
  stamp = "2026-01-01T00:00:00.000Z";
const actor = { kind: "agent", id: "admission" } as const;
const policy = new RecordFamilyRegistry([workFamilyPolicy]);
const issue = {
  id: "work-1",
  title: "one",
  status: "open",
  labels: [],
  dependsOn: [],
  createdAt: stamp,
};
const journal = {
  id: "work-1",
  pr: 7,
  url: "https://github.com/example/repo/pull/7",
  head: "a".repeat(40),
  mergeCommit: "b".repeat(40),
  branch: "work-1",
  named: [],
  step: "receipt",
  receipt: "receipt-1",
  recorded: {},
  counters: { actions: 0, records: 0 },
};
const ask = {
  lane: "work-1",
  issue: "work-1",
  title: "one",
  reason: "stopped",
  options: [
    { label: "A", text: "continue" },
    { label: "B", text: "hold", hold: true },
  ],
  default: "B",
  queuedAt: stamp,
  status: "held",
  answer: {
    label: "B",
    quote: "hold",
    source: { harness: "codex", thread: "one", message: "one" },
    at: stamp,
  },
};
async function fixture() {
  const opened = await createSqliteStore(process.cwd()).open({
    path: ":memory:",
    readOnly: false,
  });
  if (!opened.ok) throw new Error("Fixture store refused");
  const db = opened.handle.value;
  const source = new StateOwner(db, { now: () => Date.parse(stamp) });
  source.initialize();
  const owner = new StateOwner(db, { now: () => Date.parse(stamp) }, policy);
  const state = createStateClient({
    owner,
    namespace,
    context: { variant: "project", actor, project: { id: "fixture" } },
    write: true,
    requestId: "fixture",
  });
  const seed = (key: string, value: unknown) =>
    source.put(namespace, key, value, actor, {
      expectRevision: source.get(namespace, key)?.revision ?? 0,
    });
  seed("issue:work-1", issue);
  const snapshot = () =>
    ["state_records", "state_events", "state_requests"].map((table) =>
      db.all(`SELECT * FROM ${table}`),
    );
  return {
    source,
    owner,
    state,
    seed,
    snapshot,
    close: () => opened.handle.close(),
  };
}

test.each([
  [
    "misplaced held ask",
    "autopilot-ask:work-2",
    ask,
    "lane.resume",
    { all: true },
    "WORK_VALUE_KEY",
  ],
  [
    "journal recorded null",
    "autopilot:work-1",
    { ...journal, recorded: null },
    "lane.next",
    { id: "work-1" },
    "WORK_VALUE_SHAPE",
  ],
  [
    "malformed resumed state",
    "autopilot:global",
    { stopped: {}, resumed: { at: 42, scope: [] } },
    "lane.resume",
    { all: true },
    "WORK_VALUE_SHAPE",
  ],
] as const)(
  "the strict boundary refuses %s without changing the store",
  async (_name, key, value, op, input, reason) => {
    const f = await fixture();
    try {
      f.seed("issue:work-1", {
        ...issue,
        status: "closed",
        receipt: "receipt-1",
      });
      f.seed("autopilot:global", { stopAll: stamp, stopped: {} });
      if (op === "lane.next") f.seed("autopilot:global", { stopped: {} });
      f.seed("autopilot-clock:work-1", { startedAt: new Date().toISOString() });
      f.seed(key, value);
      const before = f.snapshot();
      await expect(
        Promise.resolve().then(() =>
          operations[op]!({
            input,
            signal: new AbortController().signal,
            deadline: Date.now() + 10_000,
            config: {
              lanes: {
                autopilot: {
                  enabled: true,
                  receiptChecks: ["typecheck"],
                  rebuild: { argv: ["node", "--version"] },
                },
              },
            },
            services: {
              state: f.state,
              files: { root: "/fixture", read: () => "[]" },
              environment: { select: () => ({}) },
              receipts: {
                get: () => ({
                  status: "PASS",
                  subject: journal.mergeCommit,
                  checked: [{ name: "typecheck", status: "PASS" }],
                }),
              },
              process: {
                resolve: (path: string) => ({ kind: "resolved", path }),
                run: () =>
                  Promise.resolve({
                    stdout: JSON.stringify({
                      state: "MERGED",
                      headRefName: "work-1",
                      headRefOid: journal.head,
                      mergeCommit: { oid: journal.mergeCommit },
                      url: journal.url,
                    }),
                    stderr: "",
                    exitCode: 0,
                    timedOut: false,
                    truncated: false,
                  }),
              },
            },
          }),
        ),
      ).rejects.toMatchObject({
        error: { code: "INPUT_INVALID", message: reason },
      });
      expect(f.snapshot()).toEqual(before);
    } finally {
      await f.close();
    }
  },
);

test.each(["get", "list", "listRange"] as const)(
  "%s strictly refuses a legacy closed issue without evidence",
  async (method) => {
    const f = await fixture();
    try {
      f.seed("issue:work-1", { ...issue, status: "closed" });
      const before = f.snapshot();
      const read = () =>
        method === "get"
          ? f.state.get("issue:work-1")
          : method === "list"
            ? f.state.list("issue:")
            : f.state.listRange({ from: "issue:", to: "issue;", limit: 5 });
      expect(read).toThrow("WORK_VALUE_CLOSE_EVIDENCE");
      expect(f.snapshot()).toEqual(before);
    } finally {
      await f.close();
    }
  },
);

test("the trusted candidate callback refuses before a candidate can be overwritten", async () => {
  const f = await fixture();
  try {
    const before = f.snapshot();
    expect(() =>
      f.state.validateRecord("issue:work-1", { ...issue, status: "closed" }),
    ).toThrow("WORK_VALUE_CLOSE_EVIDENCE");
    expect(f.snapshot()).toEqual(before);
    f.state.validateRecord("issue:work-1", issue);
  } finally {
    await f.close();
  }
});

test("one compiled policy reaches an explicitly enrolled local owner and its restore", async () => {
  const f = await fixture();
  const local = new LocalState(
    ":memory:",
    createSqliteStore(process.cwd()),
    undefined,
    undefined,
    undefined,
    undefined,
    policy,
  );
  try {
    const target = (await local.open(true))!;
    expect(target.hasRecordFamilies(namespace)).toBe(true);
    f.seed("issue:work-1", { ...issue, status: "closed" });
    expect(() => target.restore(f.source.export())).toThrow(
      "WORK_VALUE_CLOSE_EVIDENCE",
    );
    expect(target.list(namespace)).toEqual([]);
    f.seed("issue:work-1", issue);
    target.restore(f.source.export());
    expect(target.get(namespace, "issue:work-1")?.value).toEqual(issue);
  } finally {
    await local.close();
    await f.close();
  }
});

test("ordinary local owners remain unenrolled until repaired-copy cutover", async () => {
  const local = new LocalState(":memory:", createSqliteStore(process.cwd()));
  try {
    const owner = (await local.open(true))!;
    expect(owner.hasRecordFamilies(namespace)).toBe(false);
    const legacy = { ...issue, status: "closed" };
    owner.put(namespace, "issue:work-1", legacy, actor, { expectRevision: 0 });
    expect(owner.get(namespace, "issue:work-1")?.value).toEqual(legacy);
  } finally {
    await local.close();
  }
});
