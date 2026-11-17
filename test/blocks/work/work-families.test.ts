import { test, setDefaultTimeout } from "bun:test";
import { deepStrictEqual as eq, ok, throws } from "node:assert/strict";
import { tmpdir } from "node:os";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import { StateOwner } from "../../../src/core/state/index.ts";
import type { NamespaceFamilyPolicy } from "../../../src/core/state/families.ts";
import * as work from "../../../src/blocks/work/state-families.ts";
import {
  boundLaneKey,
  readBoundLaneKey,
} from "../../../src/blocks/work/record-primitives.ts";

setDefaultTimeout(30_000);
const stamp = "2026-11-16T00:00:00.000Z";
const actor = { kind: "agent", id: "declaration-fixture" } as const;
const holder = {
  actor,
  session: { id: "session", device: "device", agent: "test", harness: "test" },
};
const cases: readonly (readonly [string, string, unknown])[] = [
  [
    "issue",
    "issue:work-1",
    {
      id: "work-1",
      title: "one",
      status: "open",
      labels: [],
      dependsOn: [],
      createdAt: stamp,
    },
  ],
  ["comment", "comment:work-1:1", { id: "work-1", body: "comment" }],
  [
    "link",
    "link:work-1:1",
    { id: "work-1", relation: "delivers", url: "https://example.com/pull/1" },
  ],
  [
    "landing",
    "landing:work-1:1",
    {
      id: "work-1",
      pr: 1,
      receipt: "check-1",
      branch: "fix/one",
      worktree: "/fixture",
      generation: 1,
      head: "a".repeat(40),
      mergeCommit: "b".repeat(40),
      note: "landed",
    },
  ],
  ["reopen", "reopen:work-1:1", { reason: "retry", holder }],
  [
    "attempt",
    "attempt:work-1:attempt-1",
    { id: "attempt-1", holder, baseRevision: 1, createdAt: stamp },
  ],
  [
    "evidence",
    "evidence:attempt:work-1:attempt-1:1",
    { attempt: "attempt-1", sha: "a".repeat(40), holder, recordedAt: stamp },
  ],
  ["cleanup", "cleanup:work-1", { expiresAt: stamp }],
  ["slots", "slots:work-1", { count: 2, next: 1 }],
  [
    "selection",
    "selection:work-1",
    {
      mode: "single",
      chosen: [{ attempt: "attempt-1", sha: "a".repeat(40) }],
      reason: "chosen",
      holder,
      selectedAt: stamp,
    },
  ],
  [
    "allocation",
    "allocation:issue:work-",
    { prefix: "issue:work-", number: 1 },
  ],
  [
    "autopilot",
    "autopilot:work-1",
    {
      id: "work-1",
      pr: 1,
      url: "https://example.com/pull/1",
      head: "a".repeat(40),
      mergeCommit: "b".repeat(40),
      branch: "fix/one",
      named: [],
      step: "receipt",
      recorded: {},
      counters: { actions: 0, records: 0 },
    },
  ],
  ["autopilot-global", "autopilot:global", { stopped: {} }],
  ["autopilot-clock", "autopilot-clock:work-1", { startedAt: stamp }],
  [
    "autopilot-event",
    "autopilot-event:work-1:1",
    { id: "work-1", type: "guard", at: stamp, detail: { reason: "pause" } },
  ],
  [
    "autopilot-ask",
    "autopilot-ask:work-1",
    {
      lane: "work-1",
      issue: "forge-1",
      title: "one",
      reason: "pause",
      options: [
        { label: "A", text: "continue" },
        { label: "B", text: "hold" },
      ],
      default: "A",
      queuedAt: stamp,
      status: "queued",
    },
  ],
  [
    "autopilot-merge",
    "autopilot-merge:work-1",
    { head: "a".repeat(40), verdict: "MERGE", reviewer: "reviewer", at: stamp },
  ],
  ["participant", "participant:work-1:1", { holder }],
  [
    "note",
    "note:attempt:work-1:attempt-1:1",
    { attempt: "attempt-1", body: "note" },
  ],
  [
    "bound-lane",
    'bound-lane:["local","identity","Owner Project"]:work-1',
    {
      version: 1,
      id: "work-1",
      cloudId: "forge-1",
      lane: {
        issue: "work-1",
        issueId: "work-1",
        worktree: "/fixture",
        branch: "fix/one",
        brief: "brief",
      },
      grant: {
        subject: "issue:work-1",
        holder,
        generation: 1,
        expiresAt: stamp,
      },
      active: false,
    },
  ],
];

const declarations = () =>
  (
    work as unknown as {
      workFamilyDeclarations?: Readonly<
        Record<string, { key: RegExp; schema: unknown }>
      >;
    }
  ).workFamilyDeclarations;
const policy = () =>
  (work as unknown as { workFamilyPolicy?: NamespaceFamilyPolicy })
    .workFamilyPolicy;

const askValue = () =>
  cases.find(([name]) => name === "autopilot-ask")![2] as Record<
    string,
    unknown
  >;
const source = { harness: "codex", thread: "owner", message: "1" };
const answer = {
  label: "A",
  quote: "#1 A",
  source,
  at: stamp,
  approval: { request: "request-1", quote: "#1 A", source },
};
test.each([
  ["approval without approving option or gate", { status: "answered", answer }],
  [
    "approval without a gated request",
    {
      status: "answered",
      options: [
        { label: "A", text: "resume", approve: true },
        { label: "B", text: "hold", hold: true },
      ],
      gated: { op: "lane.resume", input: { id: "forge-1" } },
      answer,
    },
  ],
  [
    "approval for a different gated request",
    {
      status: "answered",
      options: [
        { label: "A", text: "resume", approve: true },
        { label: "B", text: "hold", hold: true },
      ],
      gated: {
        op: "lane.resume",
        input: { id: "forge-1" },
        request: "request-2",
      },
      answer,
    },
  ],
] as const)("ask refuses %s", (_name, patch) => {
  eq(
    work.validateDeclaredWorkRecord("autopilot-ask:work-1", {
      ...askValue(),
      ...patch,
    }),
    "WORK_VALUE_SHAPE",
  );
});

test("an ask is stored under the lane its writer key builder names", () => {
  eq(
    work.validateDeclaredWorkRecord("autopilot-ask:work-1", {
      ...askValue(),
      lane: "work-2",
    }),
    "WORK_VALUE_KEY",
  );
});

test("a corrected lane-bound ask retains its writer-generated approval", () => {
  eq(
    work.validateDeclaredWorkRecord("autopilot-ask:work-1", {
      ...askValue(),
      status: "answered",
      options: [
        { label: "A", text: "resume", approve: true },
        { label: "B", text: "hold", hold: true },
      ],
      gated: {
        op: "lane.resume",
        input: { id: "forge-1" },
        request: "request-1",
      },
      answer,
    }),
    undefined,
  );
});

test.each(["", "x".repeat(201)])(
  "a journal refuses a receipt outside writer bounds: %s",
  (receipt) => {
    const journal = cases.find(([name]) => name === "autopilot")!;
    eq(
      work.validateDeclaredWorkRecord(journal[1], {
        ...(journal[2] as Record<string, unknown>),
        receipt,
      }),
      "WORK_VALUE_SHAPE",
    );
  },
);

test.each([
  "bound-lane:[]:work-1",
  'bound-lane:["local","identity"]:work-1',
  'bound-lane:["local","identity",1]:work-1',
  'bound-lane:["local","identity","\\u0041"]:work-1',
  'bound-lane:["local", "identity","project"]:work-1',
])("the bound-lane key pattern refuses non-builder serialization %s", (key) => {
  const row = declarations()?.["bound-lane"];
  ok(row);
  eq(row.key.exec(key), null);
});

test.each([
  "Owner Project",
  'quote"and\\slash',
  "astral 😀",
  "\ud800",
  "\udc00",
])(
  "the bound-lane key pattern admits its builder serialization for %s",
  (project) => {
    const parts = { origin: "local", identity: "identity", project };
    const key = boundLaneKey(parts, "work-1");
    eq(declarations()!["bound-lane"]!.key.exec(key)?.[0], key);
    eq(readBoundLaneKey(key), { ...parts, id: "work-1" });
  },
);

test("every declared work family has a concrete valid persisted-value fixture", () => {
  const rows = declarations();
  ok(rows, "work family declarations are missing");
  eq(Object.keys(rows).sort(), cases.map(([name]) => name).sort());
  for (const [name, key] of cases) {
    eq(rows[name]!.key.exec(key)?.[0], key);
    ok(rows[name]!.schema);
  }
});

test.each(cases)(
  "declared work family %s admits its writer value",
  (_name, key, value) => {
    eq(work.validateDeclaredWorkRecord(key, value), undefined);
  },
);
test.each(cases)(
  "declared work family %s refuses a non-record value",
  (_name, key) => {
    eq(work.validateDeclaredWorkRecord(key, null), "WORK_VALUE_SHAPE");
  },
);

test.each(cases)(
  "declared work family %s refuses undeclared fields",
  (_name, key, value) => {
    eq(
      work.validateDeclaredWorkRecord(key, {
        ...(value as Record<string, unknown>),
        undeclared: true,
      }),
      "WORK_VALUE_SHAPE",
    );
  },
);

test("the lane journal retains its stored issue identity", () => {
  const journal = cases.find(([name]) => name === "autopilot")!;
  eq(
    work.validateDeclaredWorkRecord(journal[1], {
      ...(journal[2] as Record<string, unknown>),
      id: "work-2",
    }),
    "WORK_VALUE_ID",
  );
});

test.each([
  "Codex review",
  "reviewer@example.com",
  "x".repeat(200),
  "😀".repeat(100),
])("merge verdict retains accepted reviewer %s", (reviewer) => {
  const verdict = cases.find(([name]) => name === "autopilot-merge")!;
  eq(
    work.validateDeclaredWorkRecord(verdict[1], {
      ...(verdict[2] as Record<string, unknown>),
      reviewer,
    }),
    undefined,
  );
});

test.each([" ", "x".repeat(201), "😀".repeat(101)])(
  "merge verdict refuses invalid reviewer %s",
  (reviewer) => {
    const verdict = cases.find(([name]) => name === "autopilot-merge")!;
    eq(
      work.validateDeclaredWorkRecord(verdict[1], {
        ...(verdict[2] as Record<string, unknown>),
        reviewer,
      }),
      "WORK_VALUE_SHAPE",
    );
  },
);

test.each([
  ["UTF-16 reply bound", { quote: "😀".repeat(1001) }],
  [
    "blank reply source",
    { source: { harness: " ", thread: "owner", message: "1" } },
  ],
] as const)("ask admission retains the writer's %s", (_name, patch) => {
  const { approval: _approval, ...plainAnswer } = answer;
  const value = { ...askValue(), status: "answered", answer: plainAnswer };
  eq(work.validateDeclaredWorkRecord("autopilot-ask:work-1", value), undefined);
  eq(
    work.validateDeclaredWorkRecord("autopilot-ask:work-1", {
      ...value,
      answer: { ...plainAnswer, ...patch },
    }),
    "WORK_VALUE_SHAPE",
  );
});

test.each([
  [
    "earlier journal recorded refusal",
    "autopilot:work-1",
    {
      ...(cases.find(([name]) => name === "autopilot")![2] as object),
      recorded: null,
    },
  ],
  [
    "earlier resumed-shape refusal",
    "autopilot:global",
    { stopped: {}, resumed: { at: 42, scope: [] } },
  ],
  [
    "blank owner channel",
    "autopilot:global",
    { stopped: {}, owner: { channel: { harness: " ", thread: "owner" } } },
  ],
] as const)(
  "the declaration retains %s after removing writer copies",
  (_name, key, value) => {
    eq(work.validateDeclaredWorkRecord(key, value), "WORK_VALUE_SHAPE");
  },
);

test("the work policy binds the same family definitions to the generic owner", async () => {
  const declaration = policy();
  ok(declaration, "work family policy is missing");
  const result = await createSqliteStore(tmpdir()).open({
    path: ":memory:",
    readOnly: false,
  });
  if (!result.ok) throw new Error(result.unavailable.reason);
  try {
    const owner = new StateOwner(result.handle.value, { now: () => 1000 }, [
      declaration,
    ]);
    owner.initialize();
    for (const [_name, key, value] of cases)
      eq(
        owner.put("forge/work", key, value, actor, { expectRevision: 0 }).value,
        value,
      );
    const events = owner.events("forge/work");
    throws(
      () =>
        owner.put("forge/work", "future:work-1", {}, actor, {
          expectRevision: 0,
        }),
      /STATE_FAMILY_UNDECLARED/,
    );
    eq(owner.events("forge/work"), events);
  } finally {
    await result.handle.close();
  }
});

test.each([
  ["journal closing target", "autopilot", { named: ["not-an-id"] }],
  [
    "journal target with a trailing newline",
    "autopilot",
    { named: ["work-1\n"] },
  ],
  [
    "gated request id",
    "autopilot-ask",
    {
      gated: {
        op: "lane.resume",
        input: { id: "forge-1" },
        request: "request with spaces",
      },
    },
  ],
  ["untrimmed reopen claim reason", "reopen", { claimReason: "  override  " }],
  [
    "resume quote UTF-16 bound",
    "autopilot-global",
    { resumed: { at: stamp, scope: "all", quote: "x".repeat(2001) } },
  ],
  [
    "resume Unicode quote UTF-16 bound",
    "autopilot-global",
    { resumed: { at: stamp, scope: "all", quote: "😀".repeat(1001) } },
  ],
] as const)(
  "the declaration refuses the reviewed %s input",
  (_name, family, patch) => {
    const [, key, value] = cases.find(([name]) => name === family)!;
    eq(work.validateDeclaredWorkRecord(key, value), undefined);
    eq(
      work.validateDeclaredWorkRecord(key, { ...(value as object), ...patch }),
      "WORK_VALUE_SHAPE",
    );
  },
);

test.each(["x".repeat(2000), "😀".repeat(1000)])(
  "resume quote admits the writer's exact UTF-16 boundary",
  (quote) => {
    eq(
      work.validateDeclaredWorkRecord("autopilot:global", {
        stopped: {},
        resumed: { at: stamp, scope: "all", quote },
      }),
      undefined,
    );
  },
);
