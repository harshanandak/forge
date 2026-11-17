import { beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import { nodeRunIsolation } from "../../../src/adapters/node-runtime/isolation.ts";
import {
  StateOwner,
  type AcquireOptions,
} from "../../../src/core/state/index.ts";
import { RecordFamilyRegistry } from "../../../src/core/state/families.ts";
import { createStateClient } from "../../../src/assembly/state-client.ts";
import { LocalState } from "../../../src/assembly/state.ts";
import { coordinateLane } from "../../../src/assembly/cloud-lane-coordinator.ts";
import { boundLaneKey } from "../../../src/blocks/work/record-primitives.ts";
import { workFamilyPolicy } from "../../../src/blocks/work/state-families.ts";
import { refuse } from "../../../src/core/trust/index.ts";
import { inlineWorkPrimitives } from "../../../tools/bundle-work-primitives.ts";
import type { Preflight } from "../../../src/core/runtime/index.ts";
import type { AssemblyProviders } from "../../../src/assembly/providers.ts";

setDefaultTimeout(30_000);
let bundled: string;
const needle = "state.validateRecord(key, candidate);";
beforeAll(async () => {
  bundled = await inlineWorkPrimitives(
    new Bun.Transpiler({ loader: "ts" }).transformSync(
      readFileSync(
        new URL("../../../src/blocks/work/entry.cts", import.meta.url),
        "utf8",
      ),
    ),
    fileURLToPath(
      new URL("../../../src/blocks/work/record-primitives.ts", import.meta.url),
    ),
  );
  expect(bundled.split(needle)).toHaveLength(2);
});
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
const local = (registry = policy, store = createSqliteStore(process.cwd())) =>
  new LocalState(
    ":memory:",
    store,
    undefined,
    undefined,
    undefined,
    undefined,
    registry,
  );
async function fixture(registry = policy) {
  const opened = await createSqliteStore(process.cwd()).open({
    path: ":memory:",
    readOnly: false,
  });
  if (!opened.ok) throw new Error("Fixture store refused");
  const db = opened.handle.value;
  const source = new StateOwner(db, { now: () => Date.parse(stamp) });
  source.initialize();
  const owner = new StateOwner(db, { now: () => Date.parse(stamp) }, registry);
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
    ["state_records", "state_events", "state_leases", "state_requests"].map(
      (table) => db.all(`SELECT * FROM ${table}`),
    );
  return {
    source,
    db,
    owner,
    state,
    seed,
    snapshot,
    close: () => opened.handle.close(),
  };
}
async function using(
  run: (f: Awaited<ReturnType<typeof fixture>>) => unknown,
  registry = policy,
) {
  const f = await fixture(registry);
  try {
    await run(f);
  } finally {
    await f.close();
  }
}
async function invoke(
  f: Awaited<ReturnType<typeof fixture>>,
  op: string,
  input: Record<string, unknown>,
  queued = false,
  removed = false,
  source = removed ? bundled.replace(needle, "void 0;") : bundled,
) {
  const isolation = await nodeRunIsolation.open();
  if (!isolation.ok) throw new Error("Fixture isolation refused");
  const deadline = Date.now() + 10000;
  const signal = new AbortController().signal;
  try {
    return await isolation.handle.value.run({
      source,
      filename: "entry.cjs",
      operation: op,
      args: {
        input,
        deadline,
        signal,
        config: {
          lanes: {
            autopilot: {
              enabled: !queued,
              receiptChecks: ["typecheck"],
              rebuild: { argv: ["node", "--version"] },
            },
          },
        },
        services: {
          state: f.state,
          files: {
            root: "/fixture",
            read: () =>
              JSON.stringify(
                queued
                  ? [
                      {
                        issue: "work-1",
                        issueId: "work-1",
                        branch: "work-1",
                        worktree: "/lane/work-1",
                        brief: "/fixture/one.md",
                      },
                    ]
                  : [],
              ),
          },
          environment: {
            select: () => (queued ? { CLAUDE_CODE_SESSION_ID: "owner-1" } : {}),
          },
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
      },
      encode: JSON.stringify,
      fail: refuse,
      timeoutMs: 10000,
      deadline,
      signal,
      settled: () => undefined,
    });
  } finally {
    await isolation.handle.close();
  }
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
  async (_name, key, value, op, input, reason) =>
    using(async (f) => {
      f.seed("issue:work-1", {
        ...issue,
        status: "closed",
        receipt: "receipt-1",
      });
      f.seed("autopilot:global", {
        ...(op === "lane.next" ? {} : { stopAll: stamp }),
        stopped: {},
      });
      f.seed("autopilot-clock:work-1", { startedAt: new Date().toISOString() });
      f.seed(key, value);
      const before = f.snapshot();
      await expect(invoke(f, op, input)).rejects.toMatchObject({
        error: { code: "INPUT_INVALID", message: reason },
      });
      expect(f.snapshot()).toEqual(before);
    }),
);

test.each(["get", "list", "listRange"] as const)(
  "%s strictly refuses a legacy closed issue without evidence",
  async (method) =>
    using((f) => {
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
    }),
);

test.each([false, true])(
  "queued-to-sent admission, entry preflight removed=%s",
  async (removed) => {
    const family = workFamilyPolicy.families["autopilot-ask"]!;
    const registry = new RecordFamilyRegistry([
      {
        ...workFamilyPolicy,
        families: {
          ...workFamilyPolicy.families,
          "autopilot-ask": {
            ...family,
            admit: (key, value) =>
              family.admit(key, value) ??
              ((value as { status: string }).status === "queued"
                ? "QUEUED_CANDIDATE_REFUSED"
                : undefined),
          },
        },
      },
    ]);
    await using(async (f) => {
      const channel = { harness: "claude-code", thread: "claude-code:owner-1" };
      f.seed("autopilot:global", { stopped: {}, owner: { channel } });
      const before = f.snapshot();
      const result = invoke(f, "lane.next", { all: true }, true, removed);
      if (removed) {
        await result;
        expect(
          f.owner.get(namespace, "autopilot-ask:work-1")?.value,
        ).toMatchObject({ status: "sent" });
        expect(f.snapshot()).not.toEqual(before);
      } else {
        await expect(result).rejects.toMatchObject({
          error: { code: "INPUT_INVALID", message: "QUEUED_CANDIDATE_REFUSED" },
        });
        expect(f.snapshot()).toEqual(before);
      }
    }, registry);
  },
);

test.each(["lane.show", "lane.status"])(
  "enrolled device admission precedes %s bound-lane decoding",
  async (op) =>
    using(async (f) => {
      const device = local(policy, {
        open: () =>
          Promise.resolve({
            ok: true,
            handle: {
              ownership: "owned",
              value: f.db,
              close: () => Promise.resolve(),
            },
          }),
      });
      try {
        const enrolled = (await device.open(true))!;
        expect(enrolled.hasRecordFamilies(namespace)).toBe(true);
        const project = {
          origin: "local",
          identity: "identity",
          project: "fixture",
        };
        f.seed(boundLaneKey(project, "work-1"), {});
        const before = f.snapshot();
        const flight = {
          operation: { declaredOp: op },
          request: { input: { id: "work-1" } },
        } as unknown as Preflight;
        await expect(
          coordinateLane(
            flight,
            project,
            device,
            () => Promise.resolve(issue),
            {
              providers: {} as AssemblyProviders,
              env: {},
              deviceRoot: "/fixture",
              now: () => Date.parse(stamp),
            },
          ),
        ).rejects.toMatchObject({
          error: { code: "INPUT_INVALID", message: "WORK_VALUE_SHAPE" },
        });
        expect(f.snapshot()).toEqual(before);
      } finally {
        await device.close();
      }
    }),
);

test("one compiled policy reaches an explicitly enrolled local owner and its restore", async () =>
  using(async (f) => {
    const targetState = local();
    try {
      const target = (await targetState.open(true))!;
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
      await targetState.close();
    }
  }));

test("ordinary local owners remain unenrolled until repaired-copy cutover", async () => {
  const state = new LocalState(":memory:", createSqliteStore(process.cwd()));
  try {
    const owner = (await state.open(true))!;
    expect(owner.hasRecordFamilies(namespace)).toBe(false);
    const legacy = { ...issue, status: "closed" };
    owner.put(namespace, "issue:work-1", legacy, actor, { expectRevision: 0 });
    expect(owner.get(namespace, "issue:work-1")?.value).toEqual(legacy);
  } finally {
    await state.close();
  }
});

test.each([false, true])(
  "acquisition refuses custom prototypes without changing any table, nested=%s",
  async (nested) =>
    using(async (f) => {
      const state = createStateClient({
        owner: f.owner,
        namespace,
        context: {
          variant: "leased",
          leaseMode: "acquire",
          actor,
          session: { id: "fixture" },
          project: { id: "fixture" },
        },
        write: true,
        requestId: "inherited-acquire",
      });
      const candidates = {
        entries: [
          {
            key: "comment:work-1:1",
            value: nested
              ? (Object.create({ id: "work-1", body: "companion" }) as object)
              : { id: "work-1", body: "companion" },
            expectRevision: 0,
          },
        ],
        readSet: [{ key: "issue:work-1", expectRevision: 0 }],
      };
      const options: AcquireOptions = nested
        ? candidates
        : (Object.create(candidates) as AcquireOptions);
      const before = f.snapshot();
      await expect(
        Promise.resolve().then(() =>
          state.acquire("issue:work-1", 60_000, options),
        ),
      ).rejects.toMatchObject({
        error: {
          code: "INPUT_INVALID",
          message: "State values must be plain JSON",
          retry: "never",
        },
      });
      expect(f.snapshot()).toEqual(before);
    }, new RecordFamilyRegistry()),
);

test("unenrolled preflight ignores a function-valued transient candidate replaced by valid JSON", async () =>
  using(async (f) => {
    expect(f.owner.hasRecordFamilies(namespace)).toBe(false);
    expect(() =>
      f.state.validateRecord("issue:work-1", { extra: () => 1 }),
    ).not.toThrow();
    f.seed("autopilot:global", {
      stopped: {},
      owner: {
        channel: { harness: "claude-code", thread: "claude-code:owner-1" },
      },
    });
    const candidate = "const candidate = copyPlanned(value);";
    expect(bundled.split(candidate)).toHaveLength(2);
    const source = bundled.replace(
      candidate,
      `${candidate}
      if (key.startsWith("autopilot-ask:")) {
        if (candidate.status === "queued") candidate.extra = () => 1;
        else delete candidate.extra;
      }`,
    );
    await invoke(f, "lane.next", { all: true }, true, false, source);
    const stored = f.owner.get(namespace, "autopilot-ask:work-1")?.value;
    expect(stored).toMatchObject({ status: "sent" });
    expect(stored).not.toHaveProperty("extra");
  }, new RecordFamilyRegistry()));

test("an enrolled runtime admits plain VM-realm candidates through the host boundary", async () =>
  using(async (f) => {
    f.seed("autopilot:global", {
      stopped: {},
      owner: {
        channel: { harness: "claude-code", thread: "claude-code:owner-1" },
      },
    });
    await invoke(f, "lane.next", { all: true }, true);
    expect(f.owner.get(namespace, "autopilot-ask:work-1")?.value).toMatchObject(
      { status: "sent" },
    );
  }));

test.each([
  ["custom prototype", () => Object.create({ title: "inherited" }) as object],
  ["function", () => ({ extra: () => 1 })],
  ["symbol value", () => ({ extra: Symbol("extra") })],
  ["symbol key", () => ({ [Symbol("extra")]: 1 })],
  ["date", () => ({ extra: new Date() })],
  ["map", () => ({ extra: new Map() })],
  [
    "getter",
    () =>
      Object.defineProperty({}, "extra", {
        enumerable: true,
        get() {
          throw new Error("Getter must never run");
        },
      }),
  ],
  ["nonfinite number", () => ({ extra: Infinity })],
  ["array hole", () => ({ extra: new Array(1) })],
  [
    "cycle",
    () => {
      const value: { extra?: unknown } = {};
      value.extra = value;
      return value;
    },
  ],
] as const)(
  "enrolled admission refuses %s as typed non-JSON input",
  async (_name, value) =>
    using(async (f) => {
      const before = f.snapshot();
      await expect(
        Promise.resolve().then(() =>
          f.state.validateRecord("issue:work-1", value()),
        ),
      ).rejects.toMatchObject({
        error: {
          code: "INPUT_INVALID",
          retry: "never",
        },
      });
      expect(f.snapshot()).toEqual(before);
    }),
);
