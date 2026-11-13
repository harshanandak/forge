import { expect, test } from "bun:test";
import { maxSource, tablesOf } from "../../cloud/conformance/max-source.ts";
import {
  dumpOf,
  dumpPage,
  limitsFrom,
  parseDump,
} from "../../cloud/src/dump.ts";
import type { SqlDatabase, SqlRow } from "../../src/ports/store.ts";

const TABLE = "domain_cloud_command_receipts";
const limits = { ...limitsFrom({}), pageBytes: 1600 };

for (const [name, mutate] of [
  [
    "insert",
    `INSERT INTO ${TABLE}(request_id,fingerprint,outcome,result,created_at,expires_at) VALUES ('c2:new', '{}', 'ok', '{}', 1, 2)`,
  ],
  ["update", `UPDATE ${TABLE} SET expires_at=3 WHERE request_id='c2:old'`],
  ["delete", `DELETE FROM ${TABLE} WHERE request_id='c2:old'`],
] as const)
  test(`a receipt-only ${name} invalidates a dump continuation`, async () => {
    const source = await maxSource("marker");
    try {
      const db: SqlDatabase = {
        exec: (sql) => {
          source.db.run(sql);
        },
        run: (sql, args = []) => source.db.query(sql).run(...(args as never[])),
        all: (sql, args = []) =>
          source.db.query(sql).all(...(args as never[])) as SqlRow[],
        get: (sql, args = []) =>
          (source.db.query(sql).get(...(args as never[])) ?? undefined) as
            SqlRow | undefined,
        transaction: (body) => source.db.transaction(body)(),
      };
      expect(
        source.db
          .query("SELECT name FROM sqlite_schema WHERE type='table' AND name=?")
          .get(TABLE),
      ).not.toBeNull();
      db.run(
        `INSERT INTO ${TABLE}(request_id,fingerprint,outcome,result,created_at,expires_at) VALUES ('c2:old', '{}', 'ok', '{}', 1, 2)`,
      );
      const page = dumpPage(db, "start", {
        ...limits,
        pageBytes: 2_000_000,
      });
      expect(page.next).not.toBeNull();
      db.transaction(() => {
        db.run(mutate);
      });
      expect(() => dumpPage(db, page.next!, limits)).toThrow(
        "changed during the export",
      );
      const before = dumpPage(db, "start", {
        ...limits,
        pageBytes: 2_000_000,
      });
      expect(() =>
        db.transaction(() => {
          db.run(`DELETE FROM ${TABLE}`);
          throw new Error("rollback");
        }),
      ).toThrow("rollback");
      expect(() =>
        dumpPage(db, before.next!, { ...limits, pageBytes: 2_000_000 }),
      ).not.toThrow();
    } finally {
      source.db.close();
    }
  }, 30_000);

for (const [name, format, present, accepted] of [
  ["old whole", "forge-cloud-dump/1", false, true],
  ["new whole", "forge-cloud-dump/2", true, true],
  ["new missing table", "forge-cloud-dump/2", false, false],
  ["old extra table", "forge-cloud-dump/1", true, false],
  ["future whole", "forge-cloud-dump/3", true, false],
] as const)
  test(`receipt dump compatibility: ${name}`, () => {
    const tables = { ...dumpOf(undefined).tables };
    delete tables[TABLE];
    if (present) tables[TABLE] = [];
    const parse = () => parseDump(JSON.stringify({ format, tables }));
    if (accepted) {
      expect(parse().format).toBe("forge-cloud-dump/2");
      expect(parse().tables[TABLE]).toEqual([]);
    } else expect(parse).toThrow();
  }, 10_000);

test("the new receipt dump preserves wide result JSON and exact columns", async () => {
  const source = await maxSource("wide");
  try {
    const tables = tablesOf(source.db);
    expect(Object.keys(tables)).toContain(TABLE);
    const result = JSON.stringify({ body: "x".repeat(300_000) });
    tables[TABLE] = [
      {
        request_id: "c2:wide",
        fingerprint: "{}",
        outcome: "ok",
        result,
        created_at: 1,
        expires_at: 2,
      },
    ];
    const parsed = parseDump(
      JSON.stringify({ format: "forge-cloud-dump/2", tables }),
    );
    expect(parsed.tables[TABLE]![0]!.result).toBe(result);
    delete tables[TABLE][0]!.expires_at;
    expect(() =>
      parseDump(JSON.stringify({ format: "forge-cloud-dump/2", tables })),
    ).toThrow("exactly");
  } finally {
    source.db.close();
  }
}, 30_000);
