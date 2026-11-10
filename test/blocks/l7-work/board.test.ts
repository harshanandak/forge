import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { LeaseHolder } from "../../../src/generated/types.ts";
type Row = {
  id: string;
  ready: boolean;
  leaseState: string;
  blockers: unknown[];
  notReadyBecause: { code: string; id?: string }[];
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
const now = Date.parse("2026-11-10T12:00:00.000Z"),
  stamp = (offset = 0) => new Date(now + offset).toISOString();
const pr = "https://github.com/harshanandak/forge/pull/1";
const holder: LeaseHolder = {
  actor: { kind: "agent", id: "worker" },
  session: { id: "A", agent: "builder", harness: "codex", device: "laptop" },
};
const held = { holder, expiresAt: stamp(60000) };
const operations = require(resolve(root, "entry.cts")) as Record<
  string,
  Handler
>;
type Node = {
  status?: string;
  dependsOn?: string[];
  ttl?: number;
  releasedAt?: string;
};
const graph: Node[] = [
  { ttl: 60000 },
  { dependsOn: ["work-1"] },
  { status: "closed" },
  { ttl: 0 },
  { dependsOn: ["work-3"] },
  { dependsOn: ["work-99"] },
  { ttl: 60000, releasedAt: stamp(-1) },
  { status: "closed", dependsOn: ["work-1"], ttl: 60000 },
];
// Build all immutable scenario views once from the same eight-issue graph.
const scenarios = {
  mixed: graph,
  ownership: graph.slice(0, 2),
  leases: [
    { ttl: 60000 },
    { ttl: 0 },
    { ttl: 60000, releasedAt: stamp(-1) },
    {},
    { ttl: 60000, status: "closed" },
  ],
  paging: graph.slice(0, 3).map(() => ({ ttl: 60000 })),
  readonly: [{ ttl: 60000 }, { ttl: 0, dependsOn: ["work-1"] }],
} satisfies Record<string, Node[]>;
let writes = 0;
const deny = () => {
  writes++;
  throw new Error("Board attempted a write");
};
const fixtures = new Map(
  Object.entries(scenarios).map(([view, nodes]) => {
    const records = nodes.map((node: Node, i) => ({
      key: `issue:work-${i + 1}`,
      revision: 1,
      updatedAt: stamp(-(i + 1) * 1000),
      value: {
        id: `work-${i + 1}`,
        title: `Issue ${i + 1}`,
        labels: [],
        status: node.status ?? "open",
        dependsOn: node.dependsOn ?? [],
      },
    }));
    const checkpoint = {
      step: "pushed",
      branch: "b",
      worktree: ".",
      next: "review",
    };
    const extra =
      view === "ownership"
        ? [
            { key: "comment:work-1:1", value: { checkpoint } },
            {
              key: "link:work-1:1",
              value: { id: "work-1", relation: "delivers", url: pr },
            },
          ]
        : view === "paging"
          ? [{ key: "comment:work-3:1", value: { body: "Latest activity" } }]
          : [];
    const all = [
      ...records,
      ...extra.map((r) => ({ ...r, revision: 1, updatedAt: stamp() })),
    ];
    const lease = (key: string) => {
      const node: Node | undefined = nodes[Number(key.split("-").at(-1)) - 1];
      return node?.ttl === undefined
        ? undefined
        : {
            subject: key,
            generation: 1,
            holder,
            expiresAt: stamp(node.ttl),
            ...(node.releasedAt ? { releasedAt: node.releasedAt } : {}),
          };
    };
    const state = {
      now: () => now,
      get: (key: string) => all.find((r) => r.key === key),
      list: (prefix: string) => all.filter((r) => r.key.startsWith(prefix)),
      lease,
      put: deny,
      append: deny,
      acquire: deny,
      renew: deny,
      release: deny,
      events: () => [],
    };
    return [
      view,
      {
        state,
        snapshot: () =>
          structuredClone({
            records: all,
            leases: nodes,
            events: state.events(),
            writes,
          }),
      },
    ] as const;
  }),
);
const run = (view: string, op = "board", input: Record<string, unknown> = {}) =>
  operations[`issue.${op}`]!({
    input,
    services: {
      state: fixtures.get(view)!.state,
      files: { write: deny, remove: deny },
    },
  });
test("read-only project declaration for agent and human", () => {
  const read = (file: string) =>
    JSON.parse(readFileSync(resolve(root, file), "utf8")) as {
      operations: Record<string, unknown>;
    };
  expect(read("forge.block.json").operations["issue.board"]).toMatchObject({
    context: "project",
    effects: [],
    callers: ["agent", "human"],
    idempotent: true,
  });
  expect(read("docs.json").operations["issue.board"]).toBeDefined();
}, 1000);
test("A holds B; C depends on B; show checkpoint and PR", () => {
  expect(run("ownership").items).toMatchObject([
    {
      id: "work-1",
      ...held,
      leaseState: "live",
      lastCheckpointAt: stamp(),
      pr,
      dependents: [{ id: "work-2" }],
    },
  ]);
  const blocker = { id: "work-1", holder };
  expect(run("ownership", "board", { id: "work-2" }).items[0]).toMatchObject({
    id: "work-2",
    ready: false,
    blockers: [blocker],
    notReadyBecause: [{ code: "BLOCKED_BY", ...blocker }],
  });
}, 1000);
test("stale expiry; released, unheld and closed issues excluded", () => {
  const page = run("leases");
  expect(page.snapshotAt).toBe(stamp());
  expect(page.items.map((r) => [r.id, r.leaseState])).toEqual([
    ["work-1", "live"],
    ["work-2", "stale"],
  ]);
  expect(run("leases", "board", { id: "work-2" }).items[0]).toMatchObject({
    ready: true,
    notReadyBecause: [],
  });
}, 1000);
const reasons = [
  ["HELD"],
  ["BLOCKED_BY"],
  ["CLOSED"],
  [],
  [],
  ["BLOCKED_BY"],
  [],
  ["CLOSED", "HELD", "BLOCKED_BY"],
];
test.each(reasons.map((codes, n) => [n + 1, codes] as const))(
  "issue %s reasons and ready agree",
  (n, codes) => {
    const row = run("mixed", "board", { id: `work-${n}` }).items[0]!;
    expect(row.notReadyBecause.map((r) => r.code)).toEqual(codes);
    expect(row.ready).toBe(row.notReadyBecause.length === 0);
  },
  1000,
);
test("eight-issue ready set and reason details", () => {
  const rows = reasons.map(
    (_, n) => run("mixed", "board", { id: `work-${n + 1}` }).items[0]!,
  );
  const eligible = rows
    .filter((r) => r.notReadyBecause.length === 0)
    .map((r) => r.id)
    .sort();
  expect(eligible).toEqual(["work-4", "work-5", "work-7"]);
  expect(eligible).toEqual(
    run("mixed", "ready")
      .items.map((r) => r.id)
      .sort(),
  );
  expect(rows[7]!.notReadyBecause[1]).toMatchObject(held);
  expect(rows[5]!.notReadyBecause).toEqual([
    { code: "BLOCKED_BY", id: "work-99" },
  ]);
  expect(rows[4]!.blockers).toEqual([]);
}, 1000);
test("cursor pages cover held issues once by most recent activity", () => {
  let cursor: string | undefined;
  const seen: Row[] = [];
  for (const [id, truncated] of [
    ["work-3", true],
    ["work-1", true],
    ["work-2", false],
  ] as const) {
    const page = run("paging", "board", {
      limit: 1,
      ...(cursor ? { cursor } : {}),
    });
    expect(page.items.map((r) => r.id)).toEqual([id]);
    expect(page.truncated).toBe(truncated);
    if (seen.length === 0) expect(typeof page.cursor).toBe("string");
    seen.push(...page.items);
    cursor = page.cursor;
  }
  expect(cursor).toBeUndefined();
  expect(new Set(seen.map((r) => r.id)).size).toBe(3);
}, 1000);
test("reads preserve records, revisions, leases and events", () => {
  const before = fixtures.get("readonly")!.snapshot();
  const first = run("readonly", "board", { limit: 1 });
  run("readonly", "board", { cursor: first.cursor, limit: 1 });
  run("readonly", "board", { id: "work-2" });
  expect(fixtures.get("readonly")!.snapshot()).toEqual(before);
}, 1000);
