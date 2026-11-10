import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { LeaseRecord, StateRecord } from "../../../src/generated/types.ts";

type Row = {
  id: string;
  holder?: LeaseRecord["holder"];
  leaseState?: "live" | "stale";
  expiresAt?: string;
  lastCheckpointAt?: string;
  pr?: string;
  blockers: { id: string; holder?: LeaseRecord["holder"] }[];
  dependents: { id: string }[];
  ready: boolean;
  notReadyBecause: {
    code: string;
    id?: string;
    holder?: LeaseRecord["holder"];
    expiresAt?: string;
  }[];
};
type Page = {
  items: Row[];
  snapshotAt: string;
  truncated: boolean;
  cursor?: string;
};
type Handler = (call: {
  input: Record<string, unknown>;
  services: unknown;
}) => Page;
const root = resolve(import.meta.dirname, "../../../src/blocks/work");
const globals = globalThis as Record<string, unknown>;
const previousFail = globals.fail;
let operations: Record<string, Handler>;
beforeAll(() => {
  globals.fail = (code: string, message: string) => {
    throw new Error(`${code}: ${message}`);
  };
  operations = require(resolve(root, "entry.cts")) as typeof operations;
});
afterAll(() => {
  if (previousFail === undefined) delete globals.fail;
  else globals.fail = previousFail;
});
const now = Date.parse("2026-11-10T12:00:00.000Z");
const stamp = (offset = 0) => new Date(now + offset).toISOString();
function project() {
  const records = new Map<string, StateRecord>();
  const leases = new Map<string, LeaseRecord>();
  let writes = 0;
  const deny = () => {
    writes++;
    throw new Error("Board attempted a write");
  };
  const state = {
    now: () => now,
    get: (key: string) => records.get(key),
    list: (prefix: string) =>
      [...records.values()].filter((r) => r.key.startsWith(prefix)),
    lease: (key: string) => leases.get(key),
    put: deny,
    append: deny,
    acquire: deny,
    renew: deny,
    release: deny,
    events: () => [],
  };
  const seed = (key: string, value: unknown, offset = 0) =>
    records.set(key, {
      key,
      namespace: "forge/work",
      value,
      revision: 1,
      updatedAt: stamp(offset),
      updatedBy: { kind: "agent", id: "fixture" },
    });
  const issue = (n: number, dependsOn: string[] = [], status = "open") =>
    seed(
      `issue:work-${n}`,
      {
        id: `work-${n}`,
        title: `Issue ${n}`,
        kind: "task",
        labels: [],
        status,
        dependsOn,
        createdAt: stamp(-10000),
      },
      -n * 1000,
    );
  const hold = (n: number, offset = 60000, released = false) => {
    const lease: LeaseRecord = {
      subject: `issue:work-${n}`,
      generation: 1,
      holder: {
        actor: { kind: "agent", id: "worker" },
        session: {
          id: "A",
          agent: "builder",
          harness: "codex",
          device: "laptop",
        },
      },
      expiresAt: stamp(offset),
      ...(released ? { releasedAt: stamp(-1) } : {}),
    };
    leases.set(lease.subject, lease);
    return lease;
  };
  const run = (op = "board", input: Record<string, unknown> = {}) =>
    operations[`issue.${op}`]!({
      input,
      services: { state, files: { write: deny, remove: deny } },
    });
  const snapshot = () =>
    structuredClone({
      records: [...records],
      leases: [...leases],
      events: state.events(),
      writes,
    });
  return { issue, hold, run, seed, snapshot };
}

test("board declares a read-only project operation for agents and humans", () => {
  const manifest = JSON.parse(
    readFileSync(resolve(root, "forge.block.json"), "utf8"),
  ) as { operations: Record<string, unknown> };
  expect(manifest.operations["issue.board"]).toMatchObject({
    context: "project",
    effects: [],
    callers: ["agent", "human"],
    idempotent: true,
  });
  const docs = JSON.parse(readFileSync(resolve(root, "docs.json"), "utf8")) as {
    operations: Record<string, unknown>;
  };
  expect(docs.operations["issue.board"]).toBeDefined();
}, 1000);

test("A holds B and C depends on B: show the holder, reverse edge, checkpoint and PR", () => {
  const p = project();
  p.issue(1);
  p.issue(2, ["work-1"]);
  const lease = p.hold(1);
  p.seed("comment:work-1:1", {
    checkpoint: { step: "pushed", branch: "b", worktree: ".", next: "review" },
  });
  const pr = "https://github.com/harshanandak/forge/pull/1";
  p.seed("link:work-1:1", { id: "work-1", relation: "delivers", url: pr });
  expect(p.run().items).toMatchObject([
    {
      id: "work-1",
      holder: lease.holder,
      leaseState: "live",
      expiresAt: lease.expiresAt,
      lastCheckpointAt: stamp(),
      pr,
      dependents: [{ id: "work-2" }],
    },
  ]);
  expect(p.run("board", { id: "work-2" }).items[0]).toMatchObject({
    id: "work-2",
    ready: false,
    blockers: [{ id: "work-1", holder: lease.holder }],
    notReadyBecause: [
      { code: "BLOCKED_BY", id: "work-1", holder: lease.holder },
    ],
  });
}, 1000);

test("expiry at snapshot time is stale; released, unheld and closed issues stay off discovery", () => {
  const p = project();
  for (let n = 1; n <= 5; n++) p.issue(n, [], n === 5 ? "closed" : "open");
  p.hold(1);
  p.hold(2, 0);
  p.hold(3, 60000, true);
  p.hold(5);
  const page = p.run();
  expect(page.snapshotAt).toBe(stamp());
  expect(page.items.map((row) => [row.id, row.leaseState])).toEqual([
    ["work-1", "live"],
    ["work-2", "stale"],
  ]);
  expect(p.run("board", { id: "work-2" }).items[0]).toMatchObject({
    ready: true,
    notReadyBecause: [],
  });
}, 1000);

test("eight mixed issues agree exactly with ready and give CLOSED, HELD, BLOCKED_BY in order", () => {
  const p = project();
  p.issue(1);
  p.issue(2, ["work-1"]);
  p.issue(3, [], "closed");
  p.issue(4);
  p.issue(5, ["work-3"]);
  p.issue(6, ["work-99"]);
  p.issue(7);
  p.issue(8, ["work-1"], "closed");
  p.hold(1);
  p.hold(4, 0);
  p.hold(7, 60000, true);
  const lease = p.hold(8);
  const rows = Array.from(
    { length: 8 },
    (_, n) => p.run("board", { id: `work-${n + 1}` }).items[0]!,
  );
  const eligible = rows
    .filter((row) => row.notReadyBecause.length === 0)
    .map((row) => row.id)
    .sort();
  expect(eligible).toEqual(["work-4", "work-5", "work-7"]);
  expect(eligible).toEqual(
    p
      .run("ready")
      .items.map((row) => row.id)
      .sort(),
  );
  for (const row of rows)
    expect(row.ready).toBe(row.notReadyBecause.length === 0);
  expect(rows[7]!.notReadyBecause.map((reason) => reason.code)).toEqual([
    "CLOSED",
    "HELD",
    "BLOCKED_BY",
  ]);
  expect(rows[7]!.notReadyBecause[1]).toMatchObject({
    holder: lease.holder,
    expiresAt: lease.expiresAt,
  });
  expect(rows[5]!.notReadyBecause).toEqual([
    { code: "BLOCKED_BY", id: "work-99" },
  ]);
  expect(rows[4]!.blockers).toEqual([]);
}, 1000);

test("cursor pages cover all held issues once in most recent activity order", () => {
  const p = project();
  for (let n = 1; n <= 3; n++) {
    p.issue(n);
    p.hold(n);
  }
  p.seed("comment:work-3:1", { body: "Latest activity" });
  const first = p.run("board", { limit: 1 });
  expect(first.items.map((row) => row.id)).toEqual(["work-3"]);
  expect(first.truncated).toBe(true);
  expect(typeof first.cursor).toBe("string");
  const second = p.run("board", { limit: 1, cursor: first.cursor });
  expect(second.items.map((row) => row.id)).toEqual(["work-1"]);
  expect(second.truncated).toBe(true);
  const third = p.run("board", { limit: 1, cursor: second.cursor });
  expect(third.items.map((row) => row.id)).toEqual(["work-2"]);
  expect(third.truncated).toBe(false);
  expect(third.cursor).toBeUndefined();
  expect(
    new Set(
      [...first.items, ...second.items, ...third.items].map((row) => row.id),
    ).size,
  ).toBe(3);
}, 1000);

test("discovery, detail and paging preserve records, revisions, leases and events without writes", () => {
  const p = project();
  p.issue(1);
  p.issue(2, ["work-1"]);
  p.hold(1);
  p.hold(2, 0);
  const before = p.snapshot();
  const first = p.run("board", { limit: 1 });
  p.run("board", { cursor: first.cursor, limit: 1 });
  p.run("board", { id: "work-2" });
  expect(p.snapshot()).toEqual(before);
}, 1000);
