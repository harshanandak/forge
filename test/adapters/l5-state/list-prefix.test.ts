import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import { createStateClient } from "../../../src/assembly/state-client.ts";
import { StateOwner } from "../../../src/core/state/index.ts";
import type { StateRecord } from "../../../src/generated/types.ts";
import type { SqlDatabase, SqlValue } from "../../../src/ports/store.ts";

const namespace = "forge/test";
const actor = { kind: "agent" as const, id: "list-prefix" };

async function fixture() {
  const opened = await createSqliteStore(tmpdir()).open({
    path: ":memory:",
    readOnly: false,
  });
  if (!opened.ok) throw new Error(opened.unavailable.reason);
  const real = opened.handle.value;
  const counted = {
    decoded: 0,
    rows: 0,
    sql: "",
    params: [] as readonly SqlValue[],
  };
  const db: SqlDatabase = {
    exec: (sql) => real.exec(sql),
    run: (sql, params) => real.run(sql, params),
    get: (sql, params) => real.get(sql, params),
    transaction: (body) => real.transaction(body),
    all(sql, params = []) {
      const rows = real.all(sql, params);
      counted.sql = sql;
      counted.params = params;
      counted.rows = rows.length;
      // StateOwner decodes JSON by reading row.body; count those reads, not elapsed time.
      return rows.map((row) => ({
        ...row,
        get body() {
          counted.decoded++;
          return row.body!;
        },
      }));
    },
  };
  const owner = new StateOwner(db, { now: () => 1000 });
  try {
    owner.initialize();
    const special = [
      "target/",
      "target/%",
      "target/%child",
      "target/_",
      "target/_child",
      "target/A",
      "target/a",
      "target/\u{10FFFF}",
      "target/\u{10FFFF}child",
      "target/\uFFFF",
      "target/\uFFFFchild",
      "target/\u{10000}",
      "\u{10FFFF}",
      "\u{10FFFF}child",
      "\u{10FFFF}\u{10FFFF}",
      "\u{10FFFF}\u{10FFFF}child",
      "target0/nearby",
      "Target/case",
    ];
    for (const [ns, size] of [
      [namespace, 600],
      ["forge/other", 200],
      ["forge/third", 200],
    ] as const) {
      owner.putMany(
        ns,
        Array.from({ length: size }, (_, index) => ({
          key:
            special[index] ??
            `${index % 2 === 0 ? "target/" : "other/"}${String(index).padStart(4, "0")}`,
          value: { index, ns, text: "unchanged % _" },
          expectRevision: 0,
        })),
        actor,
      );
    }
    expect(real.get("SELECT count(*) AS total FROM state_records")?.total).toBe(
      1000n,
    );
    // Independent reference: fetch in the original SQLite order, then apply JS startsWith.
    const records = real
      .all("SELECT body FROM state_records WHERE namespace=? ORDER BY key", [
        namespace,
      ])
      .map((row) => JSON.parse(String(row.body)) as StateRecord);
    const client = createStateClient({
      owner,
      namespace,
      context: { variant: "stateless" },
      write: false,
      requestId: "list-prefix",
    });
    return {
      owner,
      client,
      real,
      counted,
      records,
      close: () => opened.handle.close(),
    };
  } catch (error) {
    await opened.handle.close();
    throw error;
  }
}

test("RED: a prefix range decodes matching maximal-code-point suffixes instead of excluding them", async () => {
  const { owner, counted, records, close } = await fixture();
  try {
    const prefix = "target/";
    const expected = records.filter((record) => record.key.startsWith(prefix));
    expect(expected.map((record) => record.key)).toContain(
      `${prefix}\u{10FFFF}`,
    );
    expect(expected.map((record) => record.key)).toContain(
      `${prefix}\u{10FFFF}child`,
    );
    counted.decoded = 0;
    const actual = owner.list(namespace, prefix);
    // main's prefix + U+10FFFF bound excludes both maximal suffixes: 301 decoded, not 303.
    expect(counted.decoded).toBe(303);
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
  } finally {
    await close();
  }
}, 30_000);

test("prefix selection decodes only matches, preserves binary order and treats % and _ literally", async () => {
  const { owner, client, real, counted, records, close } = await fixture();
  try {
    for (const prefix of [
      "",
      "target/",
      "target/%",
      "target/_",
      "target/A",
      "Target/",
      "target/\uFFFF",
      "target/\u{10000}",
      "target/\u{10FFFF}",
      "\u{10FFFF}",
      "\u{10FFFF}\u{10FFFF}",
      "missing/",
    ]) {
      const expected = records.filter((record) =>
        record.key.startsWith(prefix),
      );
      for (const read of [
        () => owner.list(namespace, prefix),
        () => owner.client(namespace, actor).list(prefix),
        () => client.list(prefix),
      ]) {
        counted.decoded = 0;
        const actual = read();
        expect(counted.decoded).toBe(expected.length);
        expect(counted.rows).toBe(expected.length);
        expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
        const plan = real
          .all(`EXPLAIN QUERY PLAN ${counted.sql}`, counted.params)
          .map((row) => String(row.detail))
          .join(" ");
        expect(plan).toContain(
          "SEARCH state_records USING INDEX sqlite_autoindex_state_records_1",
        );
        expect(plan).not.toContain("SCAN");
        expect(plan).not.toContain("TEMP B-TREE");
      }
    }
  } finally {
    await close();
  }
}, 30_000);

test("already working on main: listRange decodes at most its limit before JS truncation", async () => {
  const { owner, client, counted, records, close } = await fixture();
  try {
    for (const descending of [false, true]) {
      for (const limit of [1, 7, 1000]) {
        const range = { from: "target/", to: "target0", limit, descending };
        const matching = records.filter((record) =>
          record.key.startsWith("target/"),
        );
        const expected = (descending ? matching.toReversed() : matching).slice(
          0,
          limit,
        );
        for (const read of [
          () => owner.listRange(namespace, range),
          () => owner.client(namespace, actor).listRange(range),
          () => client.listRange(range),
        ]) {
          counted.decoded = 0;
          const actual = read();
          expect(counted.decoded).toBe(expected.length);
          expect(counted.decoded).toBeLessThanOrEqual(limit);
          expect(counted.rows).toBe(expected.length);
          expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
        }
      }
    }
  } finally {
    await close();
  }
}, 30_000);
