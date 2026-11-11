import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  SCHEMA_DOCUMENTS,
  SchemaRegistry,
  type SchemaObject,
} from "../../../src/contract/index.ts";
import { refuse } from "../../../src/core/trust/index.ts";
import type { LeaseHolder } from "../../../src/generated/types.ts";
type Row = {
  id: string;
  ready: boolean;
  leaseState: string;
  blockers: unknown[];
  dependents: { id: string }[];
  blockersTotal?: number;
  dependentsTotal?: number;
  blockedByTotal?: number;
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
  title?: string;
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
const busy = (issues: number, dependencies: number): Node[] => [
  ...Array.from({ length: issues }, () => ({
    ttl: 60000,
    title: "界".repeat(150),
    dependsOn: Array.from(
      { length: dependencies },
      (_, n) => `work-${issues + n + 1}`,
    ),
  })),
  ...Array.from({ length: dependencies }, () => ({ ttl: 60000 })),
];
const scenarios = {
  overflow: busy(100, 256),
  capped: busy(25, 25),
  small: busy(20, 20),
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
    let clock = now;
    const activity = new Map<string, string>();
    const records = nodes.map((node: Node, i) => ({
      key: `issue:work-${i + 1}`,
      revision: 1,
      updatedAt: stamp(-(i + 1) * 1000),
      value: {
        id: `work-${i + 1}`,
        title: node.title ?? `Issue ${i + 1}`,
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
      now: () => clock,
      get: (key: string) => all.find((r) => r.key === key),
      list: (prefix: string) => all.filter((r) => r.key.startsWith(prefix)),
      lease,
      maxNumber: (prefix: string) =>
        Math.max(
          0,
          ...all
            .filter((r) => r.key.startsWith(prefix))
            .map((r) => Number(r.key.slice(prefix.length))),
        ),
      history: ({ key }: { key: string }) =>
        activity.has(key) ? [{ at: activity.get(key)! }] : [],
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
        renewSecond: () => {
          nodes[0]!.ttl = 61000;
          clock = now + 1000;
          activity.set("issue:work-1", stamp(1000));
        },
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
      crypto: {
        sha256: (text: string) =>
          createHash("sha256").update(text).digest("hex"),
      },
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

test("renewing the second holder between pages refuses a stale cursor", () => {
  const previous: unknown = Reflect.get(globalThis, "fail");
  Reflect.set(globalThis, "fail", refuse);
  try {
    const first = run("paging", "board", { limit: 1 });
    fixtures.get("paging")!.renewSecond();
    expect(() =>
      run("paging", "board", { limit: 1, cursor: first.cursor }),
    ).toThrow("CURSOR_STALE: restart from the first page");
  } finally {
    Reflect.set(globalThis, "fail", previous);
  }
}, 1000);

const budgetSchema = "urn:forge:test:board-budget";
const boardSchema = JSON.parse(
  readFileSync(resolve(root, "schemas/board.output.json"), "utf8"),
) as SchemaObject;
const budgetRegistry = new SchemaRegistry([
  ...SCHEMA_DOCUMENTS,
  { ...boardSchema, $id: budgetSchema },
]);
const byteSize = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), "utf8");
const rowBytes = (rows: Row[]) =>
  rows.reduce((sum, row) => sum + byteSize(row), Math.max(0, rows.length - 1));
const budgetRun = (input: Record<string, unknown> = {}, view = "overflow") => {
  const page = run(view, "board", input);
  expect(budgetRegistry.validate(budgetSchema, page)).toEqual([]);
  return page;
};
const workIds = (start: number, count: number) =>
  Array.from({ length: count }, (_, n) => `work-${start + n}`);
const noTotals = (row: Row) => {
  for (const field of ["blockersTotal", "dependentsTotal", "blockedByTotal"])
    expect(row).not.toHaveProperty(field);
};

test("board budget: overflow fits output and stops before row limit", () => {
  const page = budgetRun();
  expect(byteSize(page)).toBeLessThan(1048576);
  expect(rowBytes(page.items)).toBeLessThanOrEqual(524288);
  expect(page.items.length).toBeLessThan(100);
  expect(page.truncated).toBe(true);
  expect(typeof page.cursor).toBe("string");
  expect(page.snapshotAt).toBe(stamp());
  expect(page.items.map((r) => r.id)).toEqual(workIds(1, page.items.length));
}, 30000);

test("board budget: full walk keeps UTF-8 boundaries and every row", () => {
  const pages: Page[] = [];
  let cursor: string | undefined;
  do {
    const page = budgetRun(cursor ? { cursor } : {});
    expect(page.items.length).toBeGreaterThan(0);
    pages.push(page);
    cursor = page.cursor;
    expect(Boolean(cursor)).toBe(page.truncated);
    expect(pages.length).toBeLessThanOrEqual(356);
  } while (cursor);
  expect(pages.flatMap((p) => p.items.map((r) => r.id))).toEqual(
    workIds(1, 356),
  );
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(workIds(1, 356)))
    .digest("hex");
  let offset = 0;
  for (const [n, page] of pages.entries()) {
    expect(byteSize(page)).toBeLessThan(1048576);
    expect(rowBytes(page.items)).toBeLessThanOrEqual(524288);
    expect(page.snapshotAt).toBe(stamp());
    offset += page.items.length;
    if (page.truncated) {
      expect(JSON.parse(page.cursor!)).toEqual([fingerprint, offset]);
      if (page.items.length < 100)
        expect(
          rowBytes(page.items) + 1 + byteSize(pages[n + 1]!.items[0]),
        ).toBeGreaterThan(524288);
    } else expect(page.cursor).toBeUndefined();
  }
}, 30000);

test("board budget: capped blockers keep HELD, order and ready", () => {
  const row = budgetRun({}, "capped").items[0]!;
  expect(row.blockers).toHaveLength(20);
  expect(row.blockersTotal).toBe(25);
  expect(row.blockedByTotal).toBe(25);
  expect(row.notReadyBecause.map((r) => r.code)).toEqual([
    "HELD",
    ...Array.from({ length: 20 }, () => "BLOCKED_BY"),
  ]);
  expect(row.notReadyBecause.slice(1).map((r) => r.id)).toEqual(
    workIds(26, 20),
  );
  expect(row.blockers).toEqual(
    row.notReadyBecause.slice(1).map(({ code: _code, ...reason }) => reason),
  );
  expect(row.ready).toBe(false);
}, 30000);

test("board budget: dependents keep prefix and total", () => {
  const row = budgetRun({}, "capped").items[25]!;
  expect(row.dependents.map((r) => r.id)).toEqual(workIds(1, 20));
  expect(row.dependentsTotal).toBe(25);
}, 30000);

test("board budget: single id keeps full lists and no totals", () => {
  for (const id of ["work-1", "work-26"]) {
    const page = budgetRun({ id }, "capped"),
      row = page.items[0]!;
    expect(page.items).toHaveLength(1);
    expect(row.blockers).toHaveLength(id === "work-1" ? 25 : 0);
    expect(row.dependents.map((r) => r.id)).toEqual(
      id === "work-26" ? workIds(1, 25) : [],
    );
    expect(row.notReadyBecause.map((r) => r.code)).toEqual([
      "HELD",
      ...row.blockers.map(() => "BLOCKED_BY"),
    ]);
    expect(row.ready).toBe(false);
    noTotals(row);
  }
}, 30000);

test("board budget: twenty edges add no totals", () => {
  for (const row of budgetRun({}, "small").items) {
    expect(row.blockers.length + row.dependents.length).toBe(20);
    noTotals(row);
  }
}, 30000);

test("board budget: limit five continues at offset five", () => {
  const page = budgetRun({ limit: 5 });
  expect(page.items.map((r) => r.id)).toEqual(workIds(1, 5));
  expect(page.truncated).toBe(true);
  const cursor = JSON.parse(page.cursor!) as [string, number];
  expect(cursor[1]).toBe(5);
  expect(
    budgetRun({ limit: 5, cursor: page.cursor }).items.map((r) => r.id),
  ).toEqual(workIds(6, 5));
}, 30000);

test("board budget: new held issue refuses byte-stopped cursor", () => {
  const page = budgetRun(),
    state = fixtures.get("overflow")!.state;
  const list = state.list,
    previous: unknown = Reflect.get(globalThis, "fail");
  scenarios.overflow.push({ ttl: 60000 });
  state.list = (prefix) => [
    ...list(prefix),
    ...(prefix === "issue:"
      ? [
          {
            ...list(prefix)[0]!,
            key: "issue:work-357",
            value: {
              id: "work-357",
              title: "New held issue",
              labels: [],
              status: "open",
              dependsOn: [],
            },
          },
        ]
      : []),
  ];
  Reflect.set(globalThis, "fail", refuse);
  try {
    expect(() => run("overflow", "board", { cursor: page.cursor })).toThrow(
      "CURSOR_STALE: restart from the first page",
    );
  } finally {
    state.list = list;
    scenarios.overflow.pop();
    Reflect.set(globalThis, "fail", previous);
  }
}, 30000);
