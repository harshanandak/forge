import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  PRE_WATERMARK,
  WATERMARK_SCHEMA,
  withoutWatermarkMigration,
} from "../../cloud/old-schema.ts";
import { tmpdir } from "node:os";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import { StateOwner } from "../../../src/core/state/index.ts";
import { baseline, migrate } from "../../../src/core/state/migrations.ts";
import type {
  SqlDatabase,
  SqlRow,
  SqlValue,
} from "../../../src/ports/store.ts";

const ns = "forge/test";
const actor = { kind: "agent" as const, id: "index" };

async function open(migrated = true) {
  const result = await createSqliteStore(tmpdir()).open({
    path: ":memory:",
    readOnly: false,
  });
  if (!result.ok) throw new Error(result.unavailable.reason);
  const real = result.handle.value;
  if (!migrated) migrate(real, [baseline]);
  const statements: { sql: string; params: readonly SqlValue[] }[] = [];
  const db: SqlDatabase = {
    exec: (sql) => real.exec(sql),
    run: (sql, params) => real.run(sql, params),
    get: (sql, params) => real.get(sql, params),
    all(sql, params) {
      statements.push({ sql, params: params ?? [] });
      return real.all(sql, params);
    },
    transaction: (body) => real.transaction(body),
  };
  const owner = new StateOwner(db, { now: () => 1000 });
  owner.initialize();
  return { owner, real, statements, close: () => result.handle.close() };
}

function plan(real: SqlDatabase, sql: string, params: readonly SqlValue[]) {
  return real
    .all(`EXPLAIN QUERY PLAN ${sql}`, params)
    .map((row) => String(row.detail))
    .join(" | ");
}

/** Fill the event log with `events` events spread over many keys. */
function fill(owner: StateOwner, events: number): void {
  for (let start = 0; start < events; start += 1000)
    owner.putMany(
      ns,
      Array.from({ length: Math.min(1000, events - start) }, (_, index) => ({
        key: `k/${start + index}`,
        value: index,
        expectRevision: 0,
      })),
      actor,
    );
}

for (const events of [1000, 10_000]) {
  test(`one key's history is an index search, not a log scan, with ${events} events in the log`, async () => {
    const { owner, real, statements, close } = await open();
    try {
      fill(owner, events);
      owner.put(ns, "k/7", "again", actor, { expectRevision: 1 });
      statements.length = 0;
      const newest = owner.history(ns, { key: "k/7", limit: 6 });
      const older = owner.history(ns, { key: "k/7", limit: 6, before: 2 });
      const all = owner.events(ns, "k/7");
      // Newest first, bounded by the limit, and the cursor moves to older events.
      expect(newest.map((event) => event.revision)).toEqual([2, 1]);
      expect(older.map((event) => event.revision)).toEqual([1]);
      expect(all).toHaveLength(2);
      // One statement per call, each answered by the (namespace, key, sequence) index.
      expect(statements).toHaveLength(3);
      for (const { sql, params } of statements) {
        const used = plan(real, sql, params);
        expect(used).toContain("state_events_by_key");
        expect(used).toContain("SEARCH");
        expect(used).not.toContain("SCAN");
      }
    } finally {
      await close();
    }
  }, 120_000);
}

test("an existing store gains the index when it is next opened for writing", async () => {
  const { owner, real, close } = await open(false);
  try {
    // Opened by the previous version: the baseline only, so no index yet.
    const indexes = () =>
      real
        .all("SELECT name FROM sqlite_master WHERE type='index'")
        .map((row) => String(row.name));
    expect(indexes()).toContain("state_events_by_key");
    expect(
      real
        .all("SELECT id FROM state_migrations ORDER BY id")
        .map((row) => String(row.id)),
    ).toEqual([
      "001_state_010",
      "002_state_events_key_index",
      "003_device_session_identity",
      "004_state_checkpoint",
      "005_state_events_namespace_index",
    ]);
    // Opening again changes nothing, and history still reads.
    owner.initialize();
    owner.put(ns, "a", 1, actor, { expectRevision: 0 });
    expect(owner.history(ns, { key: "a", limit: 5 })).toHaveLength(1);
  } finally {
    await close();
  }
}, 30_000);

test("history refuses a limit outside 1 to 1000", async () => {
  const { owner, close } = await open();
  try {
    for (const limit of [0, 1001, 2.5])
      expect(() => owner.history(ns, { key: "a", limit })).toThrow();
  } finally {
    await close();
  }
}, 30_000);

test("watermark endpoint work is independent of history, keys and other namespaces", () => {
  for (const count of [0, 1, 1000, 100000]) {
    using raw = new Database(":memory:");
    let examined = 0;
    const statements: string[] = [];
    raw.function("examined", (_sequence: number) => {
      examined++;
      return 1;
    });
    const db: SqlDatabase = {
      exec: (sql) => {
        raw.exec(sql);
      },
      run: (sql, params = []) => raw.query(sql).run(...params),
      all: (sql, params = []) => raw.query(sql).all(...params) as SqlRow[],
      get: (sql, params = []) => {
        if (sql.includes("FROM state_events") && sql.includes("namespace=?")) {
          statements.push(sql);
          sql = sql.replace(
            "namespace=?",
            "namespace=? AND examined(sequence)",
          );
        }
        return (raw.query(sql).get(...params) ?? undefined) as
          SqlRow | undefined;
      },
      transaction: (body) => raw.transaction(body)(),
    };
    const owner = new StateOwner(db, { now: () => 1000 });
    owner.initialize();
    raw.run(
      "WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<?) INSERT INTO state_events SELECT i, CASE WHEN i%2=0 THEN 'forge/other' ELSE 'forge/test' END, 'key/'||i, '{}' FROM n WHERE i<=?",
      [count, count],
    );
    for (const namespace of [ns, "forge/other", "forge/absent"]) {
      examined = 0;
      statements.length = 0;
      const expected = Number(
        raw
          .query<{ n: number }, [string]>(
            "SELECT coalesce(MAX(sequence),0) AS n FROM state_events WHERE namespace=?",
          )
          .get(namespace)?.n ?? 0,
      );
      expect(owner.namespaceRevision(namespace)).toBe(expected);
      expect(examined).toBe(expected === 0 ? 0 : 1);
      const sql = statements.at(-1)!;
      const used = raw.query(`EXPLAIN QUERY PLAN ${sql}`).all(namespace) as {
        detail: string;
      }[];
      expect(used.map((r) => r.detail).join(" ")).toContain(
        "COVERING INDEX state_events_by_namespace (namespace=?)",
      );
      expect(used.map((r) => r.detail).join(" ")).not.toContain("TEMP B-TREE");
      expect(sql).toContain("INDEXED BY state_events_by_namespace");
    }
    // The old access path on main's schema must fail this work assertion even when values match.
    if (count >= 1000) {
      for (const sql of PRE_WATERMARK) raw.run(sql);
      examined = 0;
      const old = raw
        .query<{ revision: number }, [string]>(
          "SELECT coalesce(MAX(sequence),0) AS revision FROM state_events INDEXED BY state_events_by_key WHERE namespace=? AND examined(sequence)",
        )
        .get(ns);
      expect(old?.revision).toBe(count - 1);
      expect(examined).toBe(count / 2);
      expect(() => expect(examined).toBeLessThanOrEqual(1)).toThrow();
    }
  }
}, 30_000);

test("old read-only watermark stays exact; migration removal is detected; deletes and other namespaces preserve the pin", async () => {
  const { owner, real, close } = await open();
  try {
    owner.put(ns, "gone", 1, actor, { expectRevision: 0 });
    owner.delete(ns, "gone", actor, { expectRevision: 1 });
    const expected = Number(
      real.get(
        "SELECT MAX(sequence) AS n FROM state_events WHERE namespace=?",
        [ns],
      )?.n,
    );
    owner.put("forge/other", "other", 1, actor, { expectRevision: 0 });
    const check = () => expect(real.get(WATERMARK_SCHEMA)).toBeDefined();
    check();
    for (const sql of PRE_WATERMARK) real.exec(sql);
    const Mutant = await withoutWatermarkMigration();
    new Mutant(real, { now: () => 1000 }).initialize();
    expect(check).toThrow();
    const before = real.all("SELECT * FROM state_migrations");
    const readOnly = {
      ...real,
      exec: () => {
        throw new Error("read wrote");
      },
      run: () => {
        throw new Error("read wrote");
      },
      transaction: () => {
        throw new Error("read wrote");
      },
    };
    const reader = new StateOwner(readOnly, { now: () => 1000 });
    expect(reader.namespaceRevision(ns)).toBe(expected);
    expect(reader.namespaceRevision("forge/absent")).toBe(0);
    expect(real.all("SELECT * FROM state_migrations")).toEqual(before);
    owner.initialize();
    check();
    expect(owner.namespaceRevision(ns)).toBe(expected);
  } finally {
    await close();
  }
}, 30_000);
