import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import { StateOwner } from "../../../src/core/state/index.ts";
import { createStateClient } from "../../../src/assembly/state-client.ts";
import { refuse } from "../../../src/core/trust/index.ts";
import type { HandlerCall } from "../../../src/contract/author.ts";

setDefaultTimeout(30_000);
const globals = globalThis as Record<string, unknown>,
  prior = globals.fail;
const operations = require("../../../src/blocks/work/entry.cts") as Record<
  string,
  (call: HandlerCall<Record<string, unknown>>) => unknown
>;
beforeAll(() => {
  globals.fail = refuse;
});
afterAll(() => {
  if (prior === undefined) delete globals.fail;
  else globals.fail = prior;
});
const namespace = "forge/work",
  at = "2026-01-01T00:00:00.000Z";
const actor = { kind: "agent", id: "atomic" } as const;
const channel = { harness: "claude-code", thread: "claude-code:owner-1" };
const ask = (lane: string, status = "held") => ({
  lane,
  issue: lane,
  title: lane,
  reason: "stopped",
  queuedAt: at,
  status,
  options: [
    { label: "A", text: "continue", approve: true },
    { label: "B", text: "hold", hold: true },
  ],
  default: "B",
  gated: { op: "lane.resume", input: { all: true }, request: "request-1" },
  ...(status === "held"
    ? {
        answer: {
          label: "B",
          quote: "#1 1B",
          source: { ...channel, message: "1" },
          at,
        },
      }
    : {}),
});
async function fixture() {
  const opened = await createSqliteStore(process.cwd()).open({
    path: ":memory:",
    readOnly: false,
  });
  if (!opened.ok) throw new Error("Fixture store refused");
  let rejects = (_key: string, _value: unknown) => false;
  const owner = new StateOwner(
    opened.handle.value,
    { now: () => Date.parse(at) },
    [
      {
        namespace,
        families: {
          fixture: {
            key: /[\s\S]+/,
            admit: (key, value) =>
              rejects(key, value) ? "INJECTED_WRITE_REFUSAL" : undefined,
          },
        },
      },
    ],
  );
  owner.initialize();
  const seed = (key: string, value: unknown) =>
    owner.put(namespace, key, value, actor, {
      expectRevision: owner.get(namespace, key)?.revision ?? 0,
    });
  for (const id of ["work-1", "work-2"])
    seed(`issue:${id}`, {
      id,
      title: id,
      status: "open",
      labels: [],
      dependsOn: [],
      createdAt: at,
    });
  const state = createStateClient({
    owner,
    namespace,
    context: { variant: "project", actor, project: { id: "atomic" } },
    write: true,
    requestId: "atomic",
  });
  let batches = 0,
    singles = 0;
  let beforeCommit = () => {};
  let duringReadPull = () => {};
  const config = {
    lanes: { autopilot: { enabled: true, receiptChecks: ["typecheck"] } },
  };
  const services = {
    state: {
      ...state,
      put: (...args: Parameters<typeof state.put>) => {
        singles++;
        return state.put(...args);
      },
      putMany: (...args: Parameters<typeof state.putMany>) => {
        batches++;
        beforeCommit();
        return state.putMany(...args);
      },
    },
    files: {
      root: "/project",
      read: (name: string) =>
        name === "forge-lanes.json"
          ? JSON.stringify(
              ["work-1", "work-2"].map((issue) => ({
                issue,
                issueId: issue,
                worktree: `/lane/${issue}`,
                branch: issue,
                brief: `/project/${issue}.md`,
              })),
            )
          : undefined,
    },
    environment: { select: () => ({ CLAUDE_CODE_SESSION_ID: "owner-1" }) },
    receipts: {
      get: () => ({
        status: "PASS",
        subject: "b".repeat(40),
        checked: [{ name: "typecheck", status: "PASS" }],
      }),
    },
    process: {
      resolve: (path: string) => ({ kind: "resolved", path }),
      run: async () => {
        await Promise.resolve();
        duringReadPull();
        return {
          stdout: JSON.stringify({
            state: "MERGED",
            headRefName: "work-1",
            headRefOid: "a".repeat(40),
            mergeCommit: { oid: "b".repeat(40) },
            url: "https://github.com/example/repo/pull/7",
          }),
          stderr: "",
          exitCode: 0,
          timedOut: false,
          truncated: false,
        };
      },
    },
  };
  return {
    owner,
    seed,
    config,
    beforeCommit: (fn: () => void) => {
      beforeCommit = fn;
    },
    duringReadPull: (fn: () => void) => {
      duringReadPull = fn;
    },
    close: () => opened.handle.close(),
    reject: (fn: typeof rejects) => {
      rejects = fn;
    },
    writes: () => ({ batches, singles }),
    snapshot: () =>
      Object.fromEntries(
        ["state_records", "state_events", "state_requests"].map((table) => [
          table,
          opened.handle.value.all(`SELECT * FROM ${table}`),
        ]),
      ),
    invoke: (op: string, input: Record<string, unknown>) =>
      operations[op]!({
        input,
        services,
        config,
        signal: new AbortController().signal,
        deadline: Date.now() + 10000,
      }),
  };
}

test.each(["work-1", "work-2"])(
  "resume all refuses a misplaced held ask at %s without clearing stop flags",
  async (misplaced) => {
    const f = await fixture();
    try {
      f.seed("autopilot:global", { stopAll: at, stopped: { "work-1": at } });
      f.seed("autopilot-ask:work-1", ask("work-1"));
      f.seed("autopilot-ask:work-2", ask("work-2"));
      f.seed(
        `autopilot-ask:${misplaced}`,
        ask(misplaced === "work-1" ? "work-2" : "work-1"),
      );
      f.reject(
        (key, value) =>
          key.startsWith("autopilot-ask:") &&
          key !== `autopilot-ask:${(value as { lane: string }).lane}`,
      );
      const before = f.snapshot();
      await expect(
        Promise.resolve().then(() => f.invoke("lane.resume", { all: true })),
      ).rejects.toMatchObject({
        error: { code: "INPUT_INVALID", message: "INJECTED_WRITE_REFUSAL" },
      });
      expect(f.snapshot()).toEqual(before);
    } finally {
      await f.close();
    }
  },
);

test.each([
  ["merge verdict and event", "merge", "autopilot-event:work-1:1"],
  ["owner decision and event", "decision", "autopilot-event:work-1:1"],
  ["owner replies and global acknowledgement", "reply", "autopilot:global"],
  ["request replacement across asks", "request", "autopilot-ask:work-2"],
  ["owner routing across asks", "route", "autopilot-ask:work-2"],
  ["tail action, clock and journal", "tail", "autopilot:work-1"],
] as const)(
  "%s refuse atomically when their later write is rejected",
  async (_name, mode, rejected) => {
    const f = await fixture();
    try {
      let input: Record<string, unknown>;
      if (mode === "merge")
        input = {
          id: "work-1",
          mergeGate: {
            head: "a".repeat(40),
            verdict: "MERGE",
            reviewer: "owner",
          },
        };
      else if (mode === "decision") {
        f.seed("autopilot-ask:work-1", {
          ...ask("work-1", "answered"),
          n: 1,
          answer: {
            label: "A",
            quote: "#1 1A",
            source: { ...channel, message: "1" },
            at,
            approval: {
              request: "request-1",
              quote: "#1 1A",
              source: { ...channel, message: "1" },
            },
          },
        });
        input = { id: "work-1", action: 1, result: '{"done":true}' };
      } else if (mode === "route") {
        f.seed("autopilot:global", {
          stopAll: at,
          stopped: {},
          owner: { channel },
        });
        input = { all: true };
      } else if (mode === "tail") {
        f.seed("autopilot:work-1", {
          id: "work-1",
          pr: 7,
          url: "https://github.com/example/repo/pull/7",
          head: "a".repeat(40),
          mergeCommit: "b".repeat(40),
          branch: "work-1",
          named: [],
          step: "receipt",
          recorded: {},
          counters: { actions: 0, records: 0 },
        });
        input = { id: "work-1", pr: 7 };
      } else {
        f.seed("autopilot:global", {
          stopped: {},
          owner: {
            channel,
            seq: 1,
            batch: { seq: 1, items: ["work-1", "work-2"] },
          },
        });
        for (const id of ["work-1", "work-2"])
          f.seed(`autopilot-ask:${id}`, { ...ask(id, "sent"), batch: 1 });
        input =
          mode === "reply"
            ? { reply: "#1 1A 2A", source: { ...channel, message: "1" } }
            : {
                id: "work-1",
                request: "request-2",
                replaces: "request-1",
                scope: { all: true },
              };
      }
      f.reject((key) => key === rejected);
      const before = f.snapshot();
      await expect(
        Promise.resolve().then(() =>
          f.invoke(
            mode === "route" || mode === "tail" ? "lane.next" : "lane.record",
            input,
          ),
        ),
      ).rejects.toMatchObject({
        error: { code: "INPUT_INVALID", message: "INJECTED_WRITE_REFUSAL" },
      });
      expect(f.snapshot()).toEqual(before);
    } finally {
      await f.close();
    }
  },
);

test.each(["lane.stop", "lane.resume"])(
  "%s commits its records with one batch and no single puts",
  async (op) => {
    const f = await fixture();
    try {
      f.seed("autopilot:global", { stopAll: at, stopped: {} });
      f.seed("autopilot-ask:work-1", ask("work-1"));
      f.seed("autopilot-ask:work-2", ask("work-2"));
      await f.invoke(op, { all: true });
      expect(f.writes()).toEqual({ batches: 1, singles: 0 });
      expect(f.owner.get(namespace, "autopilot:global")).toBeDefined();
      if (op === "lane.resume")
        for (const row of f.owner.list(namespace, "autopilot-ask:"))
          expect(row.value).toMatchObject({ status: "done" });
    } finally {
      await f.close();
    }
  },
);

test("queued and sent updates of one ask become one accepted batch entry", async () => {
  const f = await fixture();
  try {
    f.config.lanes.autopilot.enabled = false;
    f.seed("autopilot:global", { stopped: {}, owner: { channel } });
    await f.invoke("lane.next", { all: true });
    expect(f.writes()).toEqual({ batches: 1, singles: 0 });
    const rows = f.owner.list(namespace, "autopilot-ask:");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.value).toMatchObject({ status: "sent", batch: 1 });
      expect(row.revision).toBe(1);
    }
  } finally {
    await f.close();
  }
});

test("a late revision conflict preserves the racing write and refuses the complete runtime batch", async () => {
  const f = await fixture();
  try {
    f.seed("autopilot:global", { stopAll: at, stopped: {} });
    f.seed("autopilot-ask:work-1", ask("work-1"));
    let afterRace: ReturnType<typeof f.snapshot> | undefined;
    f.beforeCommit(() => {
      f.seed("autopilot:global", { stopAll: at, stopped: { "work-2": at } });
      afterRace = f.snapshot();
    });
    await expect(
      Promise.resolve().then(() => f.invoke("lane.resume", { all: true })),
    ).rejects.toMatchObject({ error: { code: "REVISION_CONFLICT" } });
    expect(afterRace).toBeDefined();
    if (afterRace === undefined) throw new Error("Commit race was not reached");
    expect(f.snapshot()).toEqual(afterRace);
  } finally {
    await f.close();
  }
});

test("resume of a tail after a journal race refuses without committing its staged action event", async () => {
  const f = await fixture();
  try {
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
    f.seed("autopilot:global", { stopped: {}, owner: { channel } });
    f.seed("autopilot:work-1", journal);
    f.seed("autopilot-clock:work-1", {
      startedAt: new Date().toISOString(),
    });
    let afterRace: ReturnType<typeof f.snapshot> | undefined;
    f.duringReadPull(() => {
      f.duringReadPull(() => {});
      f.seed("autopilot:work-1", {
        ...journal,
        counters: { actions: 0, records: 1 },
      });
      afterRace = f.snapshot();
    });
    let refusal: unknown;
    try {
      await f.invoke("lane.next", { all: true });
    } catch (error) {
      refusal = error;
    }
    expect(afterRace).toBeDefined();
    expect(refusal).toMatchObject({ error: { code: "REVISION_CONFLICT" } });
    expect(f.snapshot()).toEqual(afterRace!);
  } finally {
    await f.close();
  }
});
