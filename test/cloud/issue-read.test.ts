import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  MAX_LEASE_BYTES,
  MAX_RECORD_BYTES,
  readIssue,
} from "../../cloud/src/issue-read.ts";
import { readOnlyStore, type DurableStorage } from "../../cloud/src/store.ts";
import { ForgeFailure } from "../../src/contract/failure.ts";
import { stateMigrations } from "../../src/core/state/migrations.ts";
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
  const read = (input: unknown = { id: "forge-1" }, prefix = "forge") => {
    const before = snapshot(),
      start = calls.length;
    try {
      return readIssue(
        {
          records: readOnlyStore(storage, "state_records"),
          leases: readOnlyStore(storage, "state_leases"),
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
  return { db, calls, raw, rawLease, put, lease, read, refusal };
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
