import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { dumpUsage, limitsFrom } from "../../cloud/src/dump.ts";
import { INDEX_PAGE, INDEX_STATUS } from "../../cloud/src/issue-index.ts";
import { listIssues } from "../../cloud/src/issue-list.ts";
import {
  LEASE_READS,
  MODE_KEY,
  MODE_RANGE,
  RECORD_READS,
  type IssueViews,
} from "../../cloud/src/issue-read.ts";
import { domain } from "../../cloud/src/project.ts";
import { readOnlyStore, type DurableStorage } from "../../cloud/src/store.ts";
import { ForgeFailure } from "../../src/contract/failure.ts";
import { migrate, stateMigrations } from "../../src/core/state/migrations.ts";
import type { SqlDatabase, SqlRow } from "../../src/ports/store.ts";

const NS = "forge/work",
  now = 1_800_000_000_000,
  iso = (ms: number) => new Date(ms).toISOString(),
  actor = { kind: "agent", id: "tester" };
const shape = (n: number) => ({
  status: n % 7 === 0 ? "closed" : "open",
  labels: n % 3 === 0 ? ["a", "b"] : ["a"],
  dependsOn: n % 5 === 0 ? [`work-${n - 1}`] : [],
  ...(n % 4 === 0 ? { kind: "bug" } : {}),
});
const byKey = (a: number, b: number) =>
  `issue:work-${a}` < `issue:work-${b}` ? -1 : 1;

function fixture(count = 0, upgraded = true) {
  const db = new Database(":memory:");
  const sql: SqlDatabase = {
    exec: (text) => {
      db.exec(text);
    },
    run: (text, params = []) => db.query(text).run(...params),
    all: (text, params = []) => db.query(text).all(...params) as SqlRow[],
    get: (text, params = []) =>
      (db.query(text).get(...params) ?? undefined) as SqlRow | undefined,
    transaction: (body) => db.transaction(body)(),
  };
  migrate(
    sql,
    upgraded ? [...stateMigrations, ...domain.migrations] : stateMigrations,
  );
  const meter = { rows: 0 };
  const storage = {
    sql: {
      exec: (text: string, ...params: (string | number | null)[]) => {
        const rows = db.query(text).all(...params) as object[];
        meter.rows += rows.length;
        return { toArray: () => rows };
      },
    },
  } as unknown as DurableStorage;
  const body = (n: number, over: object = {}) =>
    JSON.stringify({
      namespace: NS,
      key: `issue:work-${n}`,
      revision: 3,
      value: {
        id: `work-${n}`,
        title: `Issue ${n}`,
        createdAt: iso(now - 1000),
        ...shape(n),
        ...over,
      },
      updatedAt: iso(now - 500),
      updatedBy: actor,
    });
  const put = (n: number, over: object = {}) =>
    db.run(
      "INSERT INTO state_records(namespace,key,revision,body) VALUES (?,?,3,?)",
      [NS, `issue:work-${n}`, body(n, over)],
    );
  const lease = (n: number, expiresAt: string) =>
    db.run(
      "INSERT INTO state_leases(namespace,subject,generation,body) VALUES (?,?,2,?)",
      [
        NS,
        `issue:work-${n}`,
        JSON.stringify({
          subject: `issue:work-${n}`,
          holder: { actor, session: { id: "s1" } },
          generation: 2,
          expiresAt,
        }),
      ],
    );
  for (let n = 1; n <= count; n++) {
    put(n);
    if (n % 11 === 0) lease(n, iso(now + 1000));
    else if (n % 13 === 0) lease(n, iso(now - 1000));
  }
  const views = (): IssueViews => ({
    records: readOnlyStore(storage, "state_records", RECORD_READS),
    leases: readOnlyStore(storage, "state_leases", LEASE_READS),
  });
  const list = (input: object, ready = false, mode?: "blocked" | "stale") => {
    meter.rows = 0;
    const out = listIssues(
      views(),
      input,
      now,
      "forge",
      ready ? { labelOrder: [] } : undefined,
      mode,
    );
    return { ...out, ids: out.items.map((item) => item.id), read: meter.rows };
  };
  return { db, sql, put, body, list };
}

const numbers = (count: number) =>
  Array.from({ length: count }, (_, i) => i + 1);
const named = (ids: number[]) => ids.sort(byKey).map((n) => `forge-${n}`);

test("list, ready, blocked and stale match a direct computation across keyset batches", () => {
  const f = fixture(600),
    all = numbers(600),
    open = (n: number) => shape(n).status === "open",
    closed = (dep: string) => shape(Number(dep.slice(5))).status === "closed";
  expect(f.list({}).ids).toEqual(named(all));
  expect(f.list({}).truncated).toBe(false);
  expect(f.list({}, true).ids).toEqual(
    named(
      all.filter(
        (n) => open(n) && shape(n).dependsOn.every(closed) && n % 11 !== 0,
      ),
    ),
  );
  expect(f.list({ kind: "bug", label: ["b"] }).ids).toEqual(
    named(all.filter((n) => n % 4 === 0 && n % 3 === 0)),
  );
  expect(f.list({}, false, "blocked").ids).toEqual(
    named(all.filter((n) => open(n) && !shape(n).dependsOn.every(closed))),
  );
  expect(f.list({}, false, "stale").ids).toEqual(
    named(all.filter((n) => open(n) && n % 13 === 0 && n % 11 !== 0)),
  );
  const page = f.list({ limit: 50 }, true);
  expect(page.ids).toEqual(f.list({}, true).ids.slice(0, 50));
  expect(page.truncated).toBe(true);
}, 30_000);

test("a page reads rows in proportion to the page, not to the project", () => {
  const f = fixture(600);
  for (const ready of [false, true]) {
    const page = f.list({ limit: 5 }, ready);
    expect(page.ids).toHaveLength(5);
    expect(page.read).toBeLessThan(150);
  }
}, 30_000);

test("the projection follows updates and deletes and refuses a corrupt row", () => {
  const f = fixture(12);
  f.db.run(
    "UPDATE state_records SET revision=4, body=? WHERE key='issue:work-3'",
    [f.body(3, { status: "closed" })],
  );
  f.db.run("DELETE FROM state_records WHERE key='issue:work-4'");
  expect(f.list({ status: "closed" }).ids).toEqual(named([3, 7]));
  expect(f.list({}).ids).not.toContain("forge-4");
  f.db.run(
    "INSERT INTO state_records(namespace,key,revision,body) VALUES (?,?,3,?)",
    [NS, "issue:work-99", "{bad"],
  );
  expect(() => f.list({})).toThrow(ForgeFailure);
}, 30_000);

test("each issue record write adds exactly one projection row write", () => {
  const f = fixture(2);
  const changes = (run: () => void) => {
    const total = () => Number(f.sql.get("SELECT total_changes() AS n")!.n);
    const before = total();
    run();
    return total() - before;
  };
  const touch = (n: number) => [
    () => f.put(n),
    () =>
      f.db.run("UPDATE state_records SET revision=5 WHERE key=?", [
        `issue:work-${n}`,
      ]),
    () =>
      f.db.run("DELETE FROM state_records WHERE key=?", [`issue:work-${n}`]),
  ];
  const withIndex = touch(3).map(changes);
  for (const action of ["insert", "update", "delete"])
    f.db.run(`DROP TRIGGER issue_index_${action}`);
  const without = touch(4).map(changes);
  expect(withIndex.map((n, i) => n - without[i]!)).toEqual([1, 1, 1]);
}, 30_000);

test("the read statements search a key and never scan the records or the projection", () => {
  const f = fixture(3);
  for (const [text, params] of [
    [MODE_KEY, [NS, "slots:work-1"]],
    [MODE_RANGE, [NS, "participant:work-1:", "participant:work-1;"]],
    [INDEX_PAGE, ["issue:", 5]],
    [INDEX_STATUS, ["issue:work-1"]],
  ] as const) {
    const plan = f.db.query(`EXPLAIN QUERY PLAN ${text}`).all(...params) as {
      detail: string;
    }[];
    expect(plan.map((row) => row.detail).join("\n")).not.toMatch(/SCAN/);
  }
}, 30_000);

test("status reads the usage counters in one statement and agrees with a scan", () => {
  const limits = limitsFrom({});
  for (const count of [10, 400]) {
    const f = fixture(count);
    f.db.run("DELETE FROM state_records WHERE key='issue:work-2'");
    const calls: string[] = [];
    const counting: SqlDatabase = {
      ...f.sql,
      all: (text, params) => (calls.push(text), f.sql.all(text, params)),
      get: (text, params) => (calls.push(text), f.sql.get(text, params)),
    };
    expect(dumpUsage(counting, limits, true)).toEqual(dumpUsage(f.sql, limits));
    expect(calls).toHaveLength(1);
  }
}, 30_000);

test("an unmigrated project refuses every list read and names the upgrade", () => {
  const f = fixture(3, false);
  for (const [ready, mode] of [
    [false, undefined],
    [true, undefined],
    [false, "blocked"],
    [false, "stale"],
  ] as const) {
    expect(() => f.list({}, ready, mode)).toThrow(
      /POST \/p\/<project>\/upgrade/,
    );
  }
}, 30_000);

test("a dependency whose index row is not usable is refused, never read as open", () => {
  const f = fixture(100);
  f.db.run("UPDATE state_records SET body=? WHERE key='issue:work-1'", [
    f.body(1, { dependsOn: ["work-99"] }),
  ]);
  for (const [ok, message] of [
    [0, /not valid/],
    [2, /Issue forge-99 is over its read budget/],
  ] as const) {
    f.db.run(
      "UPDATE domain_cloud_issue_index SET ok=? WHERE key='issue:work-99'",
      [ok],
    );
    expect(() => f.list({ limit: 1 }, true)).toThrow(message);
    expect(() => f.list({ limit: 1 }, false, "blocked")).toThrow(message);
  }
}, 30_000);

test("a maximum schema-valid issue stays listable and an oversized one is named", () => {
  const f = fixture(2);
  const text = (n: number, chars: number) =>
    String.fromCharCode(1).repeat(chars - 4) + String(n).padStart(4, "0");
  f.db.run("UPDATE state_records SET body=? WHERE key='issue:work-1'", [
    f.body(1, {
      labels: Array.from({ length: 64 }, (_, i) => text(i, 100)),
      dependsOn: Array.from({ length: 256 }, (_, i) => text(i, 200)),
      parent: text(0, 200),
    }),
  ]);
  const row = f.sql.get(
    "SELECT ok FROM domain_cloud_issue_index WHERE key='issue:work-1'",
  );
  expect(Number(row!.ok)).toBe(1);
  expect(f.list({}).ids).toContain("forge-1");
  f.db.run("UPDATE state_records SET body=? WHERE key='issue:work-2'", [
    f.body(2, { kind: "k".repeat(1_100_000) }),
  ]);
  expect(() => f.list({})).toThrow(/Issue forge-2 is over its read budget/);
}, 30_000);

test("a kind past the schema bound is refused and the bound itself stays listable", () => {
  const f = fixture(2);
  const setKind = (kind: string) =>
    f.db.run("UPDATE state_records SET body=? WHERE key='issue:work-1'", [
      f.body(1, { kind }),
    ]);
  setKind("k".repeat(64));
  expect(f.list({}).ids).toContain("forge-1");
  setKind("k".repeat(65));
  expect(() => f.list({})).toThrow(/Stored issue is not valid/);
}, 30_000);

test("only a missing issue index asks for the upgrade", () => {
  const failing = (message: string) =>
    ({
      records: {
        all: () => {
          throw new Error(message);
        },
        get: () => {
          throw new Error(message);
        },
      },
    }) as unknown as IssueViews;
  expect(() =>
    listIssues(failing("no such table: state_leases"), {}, now, "forge"),
  ).toThrow("no such table: state_leases");
  expect(() =>
    listIssues(
      failing("no such table: domain_cloud_issue_index"),
      {},
      now,
      "forge",
    ),
  ).toThrow(/POST \/p\/<project>\/upgrade/);
}, 30_000);
