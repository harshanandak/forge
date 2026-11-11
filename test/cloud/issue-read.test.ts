import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  LEASE_READS,
  MAX_DEPTH,
  MAX_LEASE_BYTES,
  MAX_NODES,
  MAX_RECORD_BYTES,
  readIssue,
  RECORD_READS,
  type IssueViews,
} from "../../cloud/src/issue-read.ts";
import { readOnlyStore, type DurableStorage } from "../../cloud/src/store.ts";
import { ForgeFailure } from "../../src/contract/failure.ts";
import { stateMigrations } from "../../src/core/state/migrations.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import { exitCode } from "../../src/surface/result.ts";

const NS = "forge/work",
  now = 1_800_000_000_000,
  actor = { kind: "agent", id: "tester" } as const,
  holder = { actor, session: { id: "s1" } },
  marker = "leak-me",
  iso = (ms: number) => new Date(ms).toISOString(),
  bytes = (text: string) => new TextEncoder().encode(text).length;
const issue = (n: number | string, over: object = {}) => ({
  id: `work-${n}`,
  title: `Issue ${n}`,
  status: "open",
  labels: ["a"],
  dependsOn: [],
  createdAt: iso(now - 1000),
  ...over,
});
const wrap = (value: unknown, over: object = {}) => ({
  namespace: NS,
  key: "issue:work-1",
  revision: 3,
  value,
  updatedAt: iso(now - 500),
  updatedBy: actor,
  ...over,
});
const grant = (over: object = {}, subject = "issue:work-1") => ({
  subject,
  holder,
  generation: 2,
  expiresAt: iso(now + 1000),
  ...over,
});
const internal = ["INTERNAL", 1, "Stored issue is not valid"];

// The tables come from the state owner's own migrations, so a change to them breaks these tests.
function fixture(tables = true) {
  const db = new Database(":memory:"),
    calls: string[] = [];
  if (tables)
    for (const { statements } of stateMigrations)
      for (const sql of statements) db.run(sql);
  const storage = {
    sql: {
      exec: (sql: string, ...params: (string | number | null)[]) => {
        calls.push(sql);
        return { toArray: () => db.query(sql).all(...params) as object[] };
      },
    },
  } as unknown as DurableStorage;
  const snapshot = () =>
    JSON.stringify(
      (
        db
          .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY 1")
          .all() as { name: string }[]
      ).map(({ name }) => [name, db.query(`SELECT * FROM "${name}"`).all()]),
    );
  const raw = (key: string, body: string, ns = NS) =>
    db.run(
      "INSERT INTO state_records(namespace,key,revision,body) VALUES (?,?,3,?)",
      [ns, key, body],
    );
  const rawLease = (subject: string, body: string, ns = NS) =>
    db.run(
      "INSERT INTO state_leases(namespace,subject,generation,body) VALUES (?,?,2,?)",
      [ns, subject, body],
    );
  const put = (key: string, value: unknown, over: object = {}, ns = NS) =>
    raw(key, JSON.stringify(wrap(value, { key, ...over })), ns);
  const lease = (over: object = {}, subject = "issue:work-1", ns = NS) =>
    rawLease(subject, JSON.stringify(grant(over, subject)), ns);
  // A test may replace the views, for example with spies that must never be called.
  let views: IssueViews | undefined;
  const read = (...args: [input?: unknown, prefix?: string]) => {
    const input = args.length > 0 ? args[0] : { id: "forge-1" },
      prefix = (args.length > 1 ? args[1] : "forge") as string;
    const before = snapshot(),
      start = calls.length;
    try {
      return readIssue(
        views ?? {
          records: readOnlyStore(storage, "state_records", RECORD_READS),
          leases: readOnlyStore(storage, "state_leases", LEASE_READS),
        },
        input,
        now,
        prefix,
      );
    } finally {
      expect(calls.slice(start).every((sql) => sql.startsWith("SELECT"))).toBe(
        true,
      );
      expect(snapshot()).toBe(before);
    }
  };
  const refusal = (...args: Parameters<typeof read>) => {
    try {
      read(...args);
    } catch (error) {
      if (!(error instanceof ForgeFailure)) throw error;
      return [
        error.error.code,
        exitCode({
          ok: false,
          status: "FAIL",
          error: error.error,
          warnings: [],
        }),
        error.error.message,
      ];
    }
    throw new Error("expected a refusal");
  };
  const use = (next: IssueViews) => {
    views = next;
  };
  return { db, calls, raw, rawLease, put, lease, read, refusal, use };
}

test("shows an exclusive issue with the configured prefix and its own revision", () => {
  const f = fixture();
  f.put(
    "issue:work-1",
    issue(1, {
      prefix: "acme",
      closeReason: marker,
      kind: "task",
      body: "b",
      parent: "work-2",
      dependsOn: ["work-2", "work-3"],
      lease: grant({ subject: marker }),
    }),
  );
  for (const id of ["forge-1", "FORGE-1", "acme-1"])
    expect(f.read({ id })).toEqual({
      id: "forge-1",
      title: "Issue 1",
      status: "open",
      labels: ["a"],
      dependsOn: ["forge-2", "forge-3"],
      parent: "forge-2",
      kind: "task",
      body: "b",
      createdAt: iso(now - 1000),
      updatedAt: iso(now - 500),
      revision: 3,
    });
}, 30_000);

test("shows a lease only while it is live by the given time", () => {
  for (const [name, over, live] of [
    ["live", { expiresAt: iso(now + 1) }, true],
    ["exactly at expiry", { expiresAt: iso(now) }, false],
    ["expired", { expiresAt: iso(now - 1) }, false],
    ["released", { releasedAt: iso(now - 5) }, false],
    ["unreadable expiry", { expiresAt: "soon" }, false],
  ] as const) {
    const f = fixture();
    f.put("issue:work-1", issue(1));
    f.lease(over);
    const item = f.read();
    expect([name, item.lease]).toEqual([name, live ? grant(over) : undefined]);
  }
}, 30_000);

test("a missing issue, table or namespace is NOT_FOUND and nothing is created", () => {
  const f = fixture();
  f.put("issue:work-2", issue(2));
  f.put("issue:work-1", issue(1), {}, "forge/other");
  expect(f.refusal().slice(0, 2)).toEqual(["NOT_FOUND", 3]);
  expect(f.refusal({ id: "forge-3" })[0]).toBe("NOT_FOUND");
  const empty = fixture(false);
  expect(empty.refusal()[0]).toBe("NOT_FOUND");
  expect(empty.refusal({ id: "acme-1" })).toEqual([
    "INPUT_INVALID",
    6,
    "Unknown issue id prefix",
  ]);
  const bare = fixture();
  bare.put("issue:work-1", issue(1));
  bare.lease({}, "issue:work-1", "forge/other");
  expect(bare.read().lease).toBeUndefined();
  bare.db.run("DROP TABLE state_leases");
  expect(bare.read().id).toBe("forge-1");
}, 30_000);

test("the number is kept as given and any historical prefix names any issue", () => {
  const f = fixture();
  f.put("issue:work-5", issue(5, { prefix: "acme" }));
  f.put("issue:work-6", issue(6));
  f.put("issue:work-007", issue("007"));
  for (const id of ["forge-7", "forge-0007"])
    expect(f.refusal({ id })[0]).toBe("NOT_FOUND");
  expect(f.read({ id: "work-007" }).id).toBe("forge-007");
  for (const id of ["acme-6", "ACME-6", "work-5"])
    expect(f.read({ id }).id).toBe(id.endsWith("6") ? "forge-6" : "forge-5");
  const refused = f.refusal({ id: `${marker}-5` });
  expect(refused).toEqual(["INPUT_INVALID", 6, "Unknown issue id prefix"]);
}, 30_000);

test("300 distinct historical prefixes with a malformed and an oversized row: a known one resolves, an unknown one is refused", () => {
  const f = fixture();
  for (let n = 1; n <= 300; n++)
    f.put(`issue:work-${n}`, issue(n, { prefix: `p${n}` }));
  f.raw("issue:work-9998", "{bad");
  f.raw("issue:work-9999", "x".repeat(MAX_RECORD_BYTES + 1));
  for (const prefix of ["p1", "p150", "p300"])
    expect(f.read({ id: `${prefix}-1` }).id).toBe("forge-1");
  expect(f.refusal({ id: "zzz-1" })).toEqual([
    "INPUT_INVALID",
    6,
    "Unknown issue id prefix",
  ]);
}, 30_000);

test("input that is not exactly an issue id is refused and never echoed", () => {
  const f = fixture();
  f.put("issue:work-1", issue(1));
  for (const input of [
    undefined,
    {},
    { id: 5 },
    { id: "forge-1", extra: marker },
    { id: `${"a".repeat(200)}-1` },
    { id: marker },
    { id: "forge" },
    { id: "-1" },
    { id: `${marker}-1x` },
  ]) {
    const [code, exit, message] = f.refusal(input);
    expect([code, exit]).toEqual(["INPUT_INVALID", 6]);
    expect(message).not.toContain(marker);
  }
}, 30_000);

test("a competing or collaborative issue is refused, even without a live lease", () => {
  const f = fixture();
  f.put("issue:work-1", issue(1));
  f.put("slots:work-12", { count: 2 });
  f.put("participant:work-12:1", {});
  expect(f.read().id).toBe("forge-1");
  for (const key of ["slots:work-1", "participant:work-1:1"]) {
    const g = fixture();
    g.put("issue:work-1", issue(1));
    g.put(key, { count: 2 });
    const [code, exit, message] = g.refusal();
    expect([code, exit]).toEqual(["INPUT_INVALID", 6]);
    expect(message).toContain("not yet supported in cloud");
  }
  const orphan = fixture();
  orphan.put("slots:work-3", { count: 2 });
  expect(orphan.refusal({ id: "forge-3" })[0]).toBe("NOT_FOUND");
}, 30_000);

type Fixture = ReturnType<typeof fixture>;
const ONE = "issue:work-1";
// Pads `text(pad)` to exactly `target` UTF-8 bytes with ASCII or two-byte characters.
const padded = (
  text: (pad: string) => string,
  target: number,
  unit: string,
) => {
  const extra = target - bytes(text(""));
  const pad =
    unit === "a"
      ? "a".repeat(extra)
      : "é".repeat(Math.floor(extra / 2)) + "a".repeat(extra % 2);
  return text(pad);
};

test("stored records and leases are bounded in bytes, not characters", () => {
  const record = (pad: string) =>
    JSON.stringify(wrap(issue(1, { closeReason: pad })));
  const expired = (pad: string) =>
    JSON.stringify(grant({ expiresAt: iso(now - 1), pad }));
  const seedLease = (f: Fixture, body: string) => {
    f.put(ONE, issue(1));
    f.rawLease(ONE, body);
  };
  for (const unit of ["a", "é"])
    for (const [max, build, seed] of [
      [MAX_RECORD_BYTES, record, (f: Fixture, b: string) => f.raw(ONE, b)],
      [MAX_LEASE_BYTES, expired, seedLease],
    ] as const)
      for (const ok of [true, false]) {
        const f = fixture();
        seed(f, padded(build, max + (ok ? 0 : 1), unit));
        if (ok) expect(f.read().id).toBe("forge-1");
        else expect(f.refusal()).toEqual(internal);
      }
}, 30_000);

test("an oversize, malformed or mismatched row never establishes a historical prefix", () => {
  const acme = (n: number, key: string, pad = "") =>
    JSON.stringify(
      wrap(issue(n, { prefix: "acme", closeReason: pad }), { key }),
    );
  const planted = [
    ["malformed json", "issue:work-2", "{bad"],
    [
      "oversize body",
      "issue:work-3",
      padded((pad) => acme(3, "issue:work-3", pad), MAX_RECORD_BYTES + 1, "a"),
    ],
    ["wrapper for another key", "issue:work-4", acme(4, "issue:work-5")],
    [
      "value not an object",
      "issue:work-6",
      JSON.stringify(wrap("acme", { key: "issue:work-6" })),
    ],
    [
      "value id for another row",
      "issue:work-2",
      JSON.stringify(
        wrap(issue(3, { prefix: "other" }), { key: "issue:work-2" }),
      ),
    ],
  ];
  for (const [name, key, body] of planted)
    for (const id of ["work-1", "acme-1", "other-1"]) {
      const f = fixture();
      f.put("issue:work-1", issue(1, { prefix: "forge" }));
      f.raw(key!, body!);
      expect([name, id, f.refusal({ id })]).toEqual([
        name,
        id,
        ["INPUT_INVALID", 6, "Unknown issue id prefix"],
      ]);
    }
}, 30_000);

test("stored depth and node count are bounded for records and leases", () => {
  const count = (v: unknown): number =>
    typeof v === "object" && v !== null
      ? 1 +
        (Object.values(v) as unknown[]).reduce<number>(
          (n, c) => n + count(c),
          0,
        )
      : 1;
  const nest = (levels: number) => {
    let value: unknown = [];
    for (let i = 1; i < levels; i++) value = [value];
    return value;
  };
  // The padding sits in a dropped field (records) or an expired lease, so the output schema
  // cannot be what refuses it. `outer` is how many containers surround the padding.
  const targets = [
    [
      (f: Fixture, pad: unknown) => f.put(ONE, issue(1, { closeReason: pad })),
      (pad: unknown) => wrap(issue(1, { closeReason: pad })),
      2,
    ],
    [
      (f: Fixture, pad: unknown) => {
        f.put(ONE, issue(1));
        f.lease({ expiresAt: iso(now - 1), pad });
      },
      (pad: unknown) => grant({ expiresAt: iso(now - 1), pad }),
      1,
    ],
  ] as const;
  for (const [seed, shell, outer] of targets) {
    const base = count(shell([]));
    for (const [pad, ok] of [
      [nest(MAX_DEPTH - outer), true],
      [nest(MAX_DEPTH - outer + 1), false],
      [new Array(MAX_NODES - base).fill(0), true],
      [new Array(MAX_NODES - base + 1).fill(0), false],
    ] as const) {
      const f = fixture();
      seed(f, pad);
      if (ok) expect(f.read().id).toBe("forge-1");
      else expect(f.refusal()).toEqual(internal);
    }
  }
}, 30_000);

test("malformed stored JSON and identity mismatches give one fixed error", () => {
  const json = (value: unknown) => JSON.stringify(value);
  const good = json(wrap(issue(1)));
  const cases: [string, string, string?][] = [
    ...["{not json", "[]", "null", '"x"'].map((b): [string, string] => [b, b]),
    ["key", json(wrap(issue(1), { key: "issue:work-2" }))],
    ["namespace", json(wrap(issue(1), { namespace: "forge/other" }))],
    ["value id", json(wrap(issue(2, { title: marker })))],
    ["value not an object", json(wrap(marker))],
    ["lease json", good, "{bad"],
    ["lease array", good, "[]"],
    ["live lease subject", good, json(grant({}, marker))],
    [
      "expired lease subject",
      good,
      json(grant({ expiresAt: iso(now - 1) }, "issue:work-2")),
    ],
  ];
  for (const [name, record, lease] of cases) {
    const f = fixture();
    f.raw(ONE, record);
    if (lease !== undefined) f.rawLease(ONE, lease);
    expect([name, f.refusal()]).toEqual([name, internal]);
  }
}, 30_000);

test("output that fails the declared schema is never returned", () => {
  const shapes: [string, object, object?][] = [
    ["no title", { title: undefined }],
    ["long title", { title: "t".repeat(501) }],
    ["bad status", { status: "weird" }],
    ["extra field", { extra: marker }],
    ["dependsOn not an array", { dependsOn: marker }],
    ["duplicate labels", { labels: ["a", "a"] }],
    ["bad kind", { kind: "Bad Kind" }],
    ["long body", { body: "b".repeat(65_537) }],
    ["revision missing", {}, { revision: undefined }],
    ["revision a string", {}, { revision: "3" }],
    ["revision zero", {}, { revision: 0 }],
    ["revision fractional", {}, { revision: 1.5 }],
    ["updatedAt missing", {}, { updatedAt: undefined }],
    ["updatedAt a number", {}, { updatedAt: 5 }],
    ["updatedAt invalid", {}, { updatedAt: "yesterday" }],
  ];
  for (const [name, over, wrapper] of shapes) {
    const f = fixture();
    f.put(ONE, issue(1, over), wrapper);
    expect([name, f.refusal()]).toEqual([name, internal]);
  }
  const badActor = { actor: { kind: "agent", id: "" }, session: { id: "s1" } };
  const leases: [string, object][] = [
    ["extra field", { extra: marker }],
    ["holder missing", { holder: undefined }],
    ["actor invalid", { holder: badActor }],
    ["session invalid", { holder: { actor, session: { id: "" } } }],
    ["generation zero", { generation: 0 }],
    ["generation a string", { generation: "2" }],
  ];
  for (const [name, over] of leases) {
    const f = fixture();
    f.put(ONE, issue(1));
    f.lease(over);
    expect([name, f.refusal()]).toEqual([name, internal]);
  }
}, 30_000);

test("an issue at the schema maxima is shown", () => {
  const f = fixture();
  const labels = Array.from({ length: 64 }, (_, i) => `l${i}`);
  const deps = Array.from({ length: 256 }, (_, i) => i + 10);
  f.put(
    ONE,
    issue(1, {
      body: "b".repeat(65_536),
      labels,
      dependsOn: deps.map((n) => `work-${n}`),
    }),
  );
  const item = f.read();
  expect([item.body?.length, item.labels, item.dependsOn]).toEqual([
    65_536,
    labels,
    deps.map((n) => `forge-${n}`),
  ]);
}, 30_000);

test("an invalid configured prefix refuses before storage is touched, ahead of bad input", () => {
  const calls: string[] = [];
  const spy = Object.fromEntries(
    ["exec", "run", "all", "get", "transaction"].map((name) => [
      name,
      () => {
        calls.push(name);
      },
    ]),
  ) as unknown as SqlDatabase;
  const f = fixture();
  f.use({ records: spy, leases: spy });
  const bad = ["Forge", "", "a_b", "x".repeat(33), "-x", "x-", "a--b"];
  for (const prefix of [...bad, undefined, null, 5, {}, ["a"]])
    for (const input of [{ id: "forge-1" }, undefined])
      expect([
        JSON.stringify([prefix]),
        f.refusal(input, prefix as string),
      ]).toEqual([
        JSON.stringify([prefix]),
        ["UNAVAILABLE", 1, "Server configuration is not valid"],
      ]);
  expect(calls).toEqual([]);
  for (const prefix of ["1a", "a-b", "x".repeat(32)]) {
    const g = fixture();
    g.put(ONE, issue(1));
    expect(g.read({ id: `${prefix}-1` }, prefix).id).toBe(`${prefix}-1`);
  }
}, 30_000);
