import { test, beforeAll, afterAll, setDefaultTimeout } from "bun:test";
import { deepStrictEqual as eq, rejects, throws } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import { createStateClient } from "../../../src/assembly/state-client.ts";
import { ForgeFailure } from "../../../src/contract/failure.ts";
import { StateOwner } from "../../../src/core/state/index.ts";
import type { StateRecord } from "../../../src/generated/types.ts";
import { writeBoundLane } from "../../../src/blocks/work/bound-lane-state.ts";

setDefaultTimeout(30_000);
const ns = "forge/work",
  stamp = "2026-11-17T00:00:00.000Z";
const now = Date.parse(stamp),
  sha = "a".repeat(40);
const holder = {
  actor: { kind: "agent", id: "writer" },
  session: { id: "writer", device: "fixture", agent: "test", harness: "test" },
} as const;
const source = { harness: "codex", thread: "owner", message: "m-1" };
const approval = { request: "request-1", quote: "#1 A", source };
const ask = (patch: Record<string, unknown> = {}) => ({
  lane: "work-1",
  issue: "work-1",
  title: "one",
  reason: "pause",
  options: [
    { label: "A", text: "resume", approve: true },
    { label: "B", text: "hold", hold: true },
  ],
  default: "B",
  gated: { op: "lane.resume", input: { id: "work-1" }, request: "request-1" },
  queuedAt: stamp,
  status: "queued",
  ...patch,
});
const answer = { label: "A", quote: "#1 A", source, at: stamp, approval };
const journal = {
  id: "work-1",
  pr: 1,
  url: "https://example.com/pull/1",
  head: sha,
  mergeCommit: "b".repeat(40),
  branch: "fix/one",
  named: [],
  step: "receipt",
  action: { n: 1, step: "receipt" },
  recorded: {},
  counters: { actions: 1, records: 0 },
};
type Call = {
  input: Record<string, unknown>;
  services: unknown;
  config: unknown;
  signal: AbortSignal;
  deadline: number;
};
type Writer = {
  [name: string]: unknown;
  writerPersist(
    state: unknown,
    key: string,
    value: unknown,
    revision: number,
  ): StateRecord;
};
const module = { exports: {} as unknown };
const entry = resolve(
  import.meta.dirname,
  "../../../src/blocks/work/entry.cts",
);
const globals = globalThis as Record<string, unknown>;
const previousFail = globals.fail;
let operations: Record<string, (call: Call) => unknown>;
const fail = (code: string, message: string): never => {
  throw new ForgeFailure({ code, message, retry: "never" });
};
beforeAll(() => {
  globals.fail = fail;
  operations = require(entry) as typeof operations;
});
afterAll(() => {
  if (previousFail === undefined) delete globals.fail;
  else globals.fail = previousFail;
});
runInNewContext(
  new Bun.Transpiler({ loader: "ts" }).transformSync(
    readFileSync(entry, "utf8"),
  ) + "\nmodule.exports.writerPersist = persist;",
  {
    module,
    exports: module.exports,
    fail,
  },
);
const writer = module.exports as Writer;
const invalid = (error: unknown) =>
  error instanceof ForgeFailure && error.error.code === "INPUT_INVALID";

async function fixture() {
  const opened = await createSqliteStore(tmpdir()).open({
    path: ":memory:",
    readOnly: false,
  });
  if (!opened.ok) throw new Error(opened.unavailable.reason);
  const db = opened.handle.value,
    owner = new StateOwner(db, { now: () => now });
  owner.initialize();
  const raw = owner.client(ns, holder.actor);
  const seed = (key: string, value: unknown) =>
    raw.put(key, value, { expectRevision: raw.get(key)?.revision ?? 0 });
  seed("issue:work-1", {
    id: "work-1",
    title: "one",
    status: "open",
    labels: [],
    dependsOn: [],
    createdAt: stamp,
  });
  seed("slots:work-1", { count: 2, next: 1 });
  seed("attempt:work-1:attempt-1", {
    id: "attempt-1",
    holder,
    baseRevision: 1,
    createdAt: stamp,
  });
  seed("evidence:attempt:work-1:attempt-1:1", {
    attempt: "attempt-1",
    sha,
    holder,
    recordedAt: stamp,
  });
  seed("autopilot:work-1", journal);
  for (const subject of ["issue:work-1", "issue:attempt:work-1:attempt-1"])
    owner.acquire(ns, subject, holder, 60_000, subject);
  let request = 0;
  const state = (leased: boolean) => ({
    ...createStateClient({
      owner,
      namespace: ns,
      write: true,
      requestId: `write-${++request}`,
      context: leased
        ? {
            variant: "leased",
            ...holder,
            project: { id: "fixture" },
            leaseMode: "held",
            leaseGeneration: 1,
          }
        : {
            variant: "project",
            actor: holder.actor,
            project: { id: "fixture" },
          },
    }),
    now: () => now,
  });
  const snapshot = () =>
    JSON.stringify(
      db
        .all(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .map(({ name }) => [
          name,
          db.all(`SELECT * FROM "${String(name)}" ORDER BY rowid`),
        ]),
      (_key, value: unknown) =>
        typeof value === "bigint" ? { bigint: value.toString() } : value,
    );
  const call = async (op: string, input: Record<string, unknown>) =>
    await operations[op]!({
      input: { id: "work-1", ...input },
      services: { state: state(!op.startsWith("lane.")) },
      config: { idPrefix: "work" },
      signal: new AbortController().signal,
      deadline: Number.MAX_SAFE_INTEGER,
    });
  return {
    owner,
    raw,
    seed,
    snapshot,
    call,
    close: () => opened.handle.close(),
  };
}

test("the unmodified writer entry loads as CommonJS through require", () => {
  eq(typeof operations["lane.record"], "function");
  eq(typeof operations["attempt.select"], "function");
});

const malformed = [
  ["misplaced ask", "autopilot-ask:work-2", ask()],
  [
    "approval without gate",
    "autopilot-ask:work-1",
    ask({ status: "answered", gated: undefined, answer }),
  ],
  [
    "approval for nonapproving option",
    "autopilot-ask:work-1",
    ask({
      status: "answered",
      options: [
        { label: "A", text: "continue" },
        { label: "B", text: "hold" },
      ],
      answer,
    }),
  ],
  [
    "approval for another request",
    "autopilot-ask:work-1",
    ask({
      status: "answered",
      answer: { ...answer, approval: { ...approval, request: "request-2" } },
    }),
  ],
  [
    "approval for another quote",
    "autopilot-ask:work-1",
    ask({
      status: "answered",
      answer: { ...answer, approval: { ...approval, quote: "other" } },
    }),
  ],
  [
    "approval from another source",
    "autopilot-ask:work-1",
    ask({
      status: "answered",
      answer: {
        ...answer,
        approval: { ...approval, source: { ...source, thread: "other" } },
      },
    }),
  ],
  ["empty receipt", "autopilot:work-1", { ...journal, receipt: "" }],
  [
    "oversized receipt",
    "autopilot:work-1",
    { ...journal, receipt: "x".repeat(201) },
  ],
  [
    "bad journal counters",
    "autopilot:work-1",
    { ...journal, counters: { actions: -1, records: 0 } },
  ],
  [
    "bad journal rounds",
    "autopilot:work-1",
    { ...journal, rounds: { review: -1 } },
  ],
  ["bad clock", "autopilot-clock:work-1", { startedAt: "not-a-time" }],
  ["bad global stopped map", "autopilot:global", { stopped: [] }],
  [
    "bad global owner",
    "autopilot:global",
    { stopped: {}, owner: { channel: { harness: "", thread: "owner" } } },
  ],
  [
    "bad merge reviewer",
    "autopilot-merge:work-1",
    { head: sha, verdict: "MERGE", reviewer: "", at: stamp },
  ],
] as const;
test.each(malformed)(
  "writer persist refuses %s before changing the store",
  async (_name, key, value) => {
    const f = await fixture();
    try {
      const before = f.snapshot();
      throws(
        () =>
          writer.writerPersist(
            f.raw,
            key,
            value,
            f.raw.get(key)?.revision ?? 0,
          ),
        invalid,
      );
      eq(f.snapshot(), before);
    } finally {
      await f.close();
    }
  },
);

test.each([
  ["queued ask", "autopilot-ask:work-1", ask()],
  ["answered ask", "autopilot-ask:work-1", ask({ status: "answered", answer })],
  [
    "held ask",
    "autopilot-ask:work-1",
    ask({
      status: "held",
      answer: { label: "B", quote: "#1 B", source, at: stamp },
    }),
  ],
  [
    "receipt boundary",
    "autopilot:work-1",
    { ...journal, receipt: "x".repeat(200) },
  ],
  [
    "runtime rounds",
    "autopilot:work-1",
    { ...journal, rounds: { review: 1, ci: 2 } },
  ],
  ["clock", "autopilot-clock:work-1", { startedAt: stamp }],
  ["global", "autopilot:global", { stopped: { "work-1": stamp } }],
  [
    "merge verdict",
    "autopilot-merge:work-1",
    { head: sha, verdict: "MERGE", reviewer: "Codex review", at: stamp },
  ],
] as const)("writer persist retains valid %s", async (_name, key, value) => {
  const f = await fixture();
  try {
    eq(
      writer.writerPersist(f.raw, key, value, f.raw.get(key)?.revision ?? 0)
        .value,
      value,
    );
  } finally {
    await f.close();
  }
});

test.each([
  ["empty reason", "attempt.select", { none: true, reason: " " }],
  [
    "oversized reason",
    "attempt.select",
    { none: true, reason: "x".repeat(65537) },
  ],
  [
    "duplicate selection",
    "attempt.select",
    { combine: `attempt-1:${sha},attempt-1:${sha}`, reason: "chosen" },
  ],
  [
    "bad evidence sha",
    "attempt.evidence",
    { attempt: "attempt-1", sha: "bad" },
  ],
  [
    "bad evidence metrics",
    "attempt.evidence",
    { attempt: "attempt-1", sha, metrics: { invalid: null } },
  ],
  [
    "too many evidence metrics",
    "attempt.evidence",
    {
      attempt: "attempt-1",
      sha,
      metrics: Object.fromEntries(
        Array.from({ length: 33 }, (_, n) => [`m${n}`, n]),
      ),
    },
  ],
  [
    "empty merge reviewer",
    "lane.record",
    { mergeGate: { head: sha, verdict: "MERGE", reviewer: "" } },
  ],
  [
    "oversized merge reviewer",
    "lane.record",
    { mergeGate: { head: sha, verdict: "MERGE", reviewer: "x".repeat(201) } },
  ],
  [
    "empty receipt result",
    "lane.record",
    { action: 1, result: JSON.stringify({ receipt: "" }) },
  ],
  [
    "oversized receipt result",
    "lane.record",
    { action: 1, result: JSON.stringify({ receipt: "x".repeat(201) }) },
  ],
  ["empty reopen reason", "issue.claim", { reopen: " " }],
] as const)(
  "writer operation refuses %s without a partial write",
  async (_name, op, input) => {
    const f = await fixture();
    try {
      const before = f.snapshot();
      await rejects(f.call(op, input), invalid);
      eq(f.snapshot(), before);
    } finally {
      await f.close();
    }
  },
);

test.each([
  [
    "attempt.select",
    { none: true, reason: "  chosen  " },
    "selection:work-1",
    "reason",
    "chosen",
  ],
  [
    "attempt.evidence",
    {
      attempt: "attempt-1",
      sha: sha.toUpperCase(),
      metrics: { ms: 1, state: "pass" },
    },
    "evidence:attempt:work-1:attempt-1:2",
    "sha",
    sha,
  ],
  [
    "lane.record",
    { action: 1, result: JSON.stringify({ receipt: "x".repeat(200) }) },
    "autopilot:work-1",
    "receipt",
    "x".repeat(200),
  ],
  [
    "lane.record",
    {
      mergeGate: { head: sha, verdict: "MERGE", reviewer: "  Codex review  " },
    },
    "autopilot-merge:work-1",
    "reviewer",
    "Codex review",
  ],
] as const)(
  "writer operation %s retains valid normalized input",
  async (op, input, key, field, expected) => {
    const f = await fixture();
    try {
      await f.call(op, input);
      eq((f.raw.get(key)?.value as Record<string, unknown>)[field], expected);
    } finally {
      await f.close();
    }
  },
);

test("ownerReply writes its approval through the real ask and global writer paths", async () => {
  const f = await fixture();
  try {
    f.seed("autopilot-ask:work-1", ask({ status: "sent", batch: 1 }));
    f.seed("autopilot:global", {
      stopped: {},
      owner: {
        channel: { harness: source.harness, thread: source.thread },
        seq: 1,
        batch: { seq: 1, items: ["work-1"] },
      },
    });
    await f.call("lane.record", { id: undefined, reply: "#1 A", source });
    const value = f.raw.get("autopilot-ask:work-1")!.value as {
      answer: { approval: unknown };
    };
    eq(value.answer.approval, approval);
    eq(
      (
        f.raw.get("autopilot:global")!.value as {
          owner: { batch: { replied: boolean } };
        }
      ).owner.batch.replied,
      true,
    );
  } finally {
    await f.close();
  }
});

test("claim reopening retains its valid normalized reasons", async () => {
  const f = await fixture();
  try {
    f.seed("issue:work-1", {
      ...(f.raw.get("issue:work-1")!.value as Record<string, unknown>),
      status: "closed",
      withoutReceipt: "closed",
    });
    await f.call("issue.claim", { reopen: "  again  ", reason: "  because  " });
    eq((f.raw.get("issue:work-1")!.value as { status: string }).status, "open");
    const value = f.raw.get("reopen:work-1:1")!.value as Record<
      string,
      unknown
    >;
    eq([value.reason, value.claimReason], ["again", "because"]);
  } finally {
    await f.close();
  }
});

test("writeBoundLane keeps valid builder keys and refuses an invalid project before write", async () => {
  const f = await fixture();
  try {
    const value = {
      version: 1,
      id: "work-1",
      cloudId: "forge-1",
      lane: {
        issue: "work-1",
        worktree: "/fixture",
        branch: "fix/one",
        brief: "brief",
      },
      grant: f.owner.lease(ns, "issue:work-1")!,
      active: false,
    } as const;
    const project = {
      origin: "local",
      identity: "identity",
      project: 'Owner "Project"\\branch',
    };
    eq(writeBoundLane(f.raw, project, value, 0).value, value);
    const before = f.snapshot();
    throws(
      () =>
        writeBoundLane(
          f.raw,
          { ...project, project: "Owner\nProject" },
          value,
          0,
        ),
      invalid,
    );
    eq(f.snapshot(), before);
  } finally {
    await f.close();
  }
});
