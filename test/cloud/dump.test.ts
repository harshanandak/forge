// Column, cursor and page boundaries of the dump, on plain tables: no Worker, no state owner.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  dumpOf,
  dumpPage,
  DUMP_MIGRATION,
  IMPORT_MIGRATION,
  limitsFrom,
  PAGE_FORMAT,
  parseDump,
  restorePage,
} from "../../cloud/src/dump.ts";
import type { SqlDatabase, SqlRow } from "../../src/ports/store.ts";
import { migrate } from "../../src/core/state/migrations.ts";
import { StateOwner } from "../../src/core/state/index.ts";

const MIB = 1024 * 1024;
const SCALAR = 262_144;
const CAP = 8 * MIB;
const limits = { ...limitsFrom({}), maxRows: 100 };
type Row = Record<string, string | number>;
// A valid row of each table, and the key its table is ordered by.
const ROW: Record<string, [Row, string]> = {
  state_records: [
    { namespace: "n", key: "k", revision: 1, body: "{}" },
    ", PRIMARY KEY (namespace, key)",
  ],
  state_events: [{ sequence: 1, namespace: "n", key: "k", body: "{}" }, ""],
  state_leases: [
    { namespace: "n", subject: "s", generation: 1, body: "{}" },
    ", PRIMARY KEY (namespace, subject)",
  ],
  state_requests: [
    { namespace: "n", request_id: "r", fingerprint: "{}", result: "{}" },
    ", PRIMARY KEY (namespace, request_id)",
  ],
  domain_cloud_requests: [
    { request_id: "r", fingerprint: "{}", outcome: "ok", result: "{}" },
    "",
  ],
  domain_cloud_command_receipts: [
    {
      request_id: "r",
      fingerprint: "{}",
      outcome: "ok",
      result: "{}",
      created_at: 1,
      expires_at: 2,
    },
    "",
  ],
};
const empty = (): Record<string, Row[]> =>
  Object.fromEntries(Object.keys(ROW).map((table) => [table, []]));
const row = (table: string, over: Row = {}): [string, Row] => [
  table,
  { ...ROW[table]![0], ...over },
];

function database(rows: [string, Row][] = []): SqlDatabase {
  const db = new Database(":memory:");
  for (const [table, [sample, key]] of Object.entries(ROW))
    if (table !== "domain_cloud_command_receipts")
      db.run(
        `CREATE TABLE ${table} (${Object.entries(sample)
          .map(([c, v]) => `${c} ${typeof v === "number" ? "INTEGER" : "TEXT"}`)
          .join(", ")}${key})`,
      );
  for (const sql of DUMP_MIGRATION.statements) db.run(sql);
  db.run("UPDATE domain_cloud_export SET epoch=?", ["0".repeat(32)]);
  for (const [table, values] of rows)
    db.run(
      `INSERT INTO ${table} (${Object.keys(values).join(", ")}) VALUES (${Object.keys(
        values,
      )
        .map(() => "?")
        .join(", ")})`,
      Object.values(values),
    );
  const params = (p: readonly unknown[] = []) => p as never[];
  return {
    exec: (sql) => {
      db.run(sql);
    },
    run: (sql, p) => db.query(sql).run(...params(p)),
    all: (sql, p) => db.query(sql).all(...params(p)) as SqlRow[],
    get: (sql, p) =>
      (db.query(sql).get(...params(p)) ?? undefined) as SqlRow | undefined,
    transaction: (body) => db.transaction(body)(),
  };
}
const codeOf = (body: () => unknown): string | undefined => {
  try {
    body();
  } catch (error) {
    // Only a ForgeFailure is an answer; any other exception is a broken test, never "no code".
    const code = (error as { error?: { code: string } }).error?.code;
    if (code === undefined) throw error;
    return code;
  }
  return undefined;
};
const bytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;
const dumpText = (table: string, over: Row) =>
  JSON.stringify({
    format: "forge-cloud-dump/2",
    tables: { ...empty(), [table]: [row(table, over)[1]] },
  });
const checkpointRows = {
  state_checkpoint_header: [1, 1, "lineage", 1, 20, 1, 20],
  state_checkpoint_live: ["forge/test", "a", 1, 1, "digest"],
  state_checkpoint_deleted: ["forge/test", "a", 1, 1],
  state_checkpoint_leases: ["forge/test", "a", 1, 1, "{}"],
  state_checkpoint_reservations: ["forge/test", "a", 1, 1],
  state_checkpoint_floors: ["forge/test", "a", 1, 0],
  state_checkpoint_receipts: ["forge/test", "a", 1, "digest", "digest"],
  state_checkpoint_denied: ["forge/test", "a", 1],
};
for (const [table, values] of Object.entries(checkpointRows)) {
  for (const paged of [false, true])
    test(`v2 ${paged ? "paged" : "whole"} export refuses ${table} without mutation`, () => {
      const db = database();
      migrate(db);
      const before = dumpOf(db);
      expect(Object.keys(before.tables)).toEqual(Object.keys(ROW));
      expect(parseDump(JSON.stringify(before))).toEqual(before);
      db.run(
        `INSERT INTO ${table} VALUES (${values.map(() => "?").join(",")})`,
        values,
      );
      const read = () => db.all(`SELECT * FROM ${table}`);
      const saved = read();
      expect(() =>
        paged ? dumpPage(db, "start", limits) : dumpOf(db),
      ).toThrow(/newer Forge/i);
      expect(read()).toEqual(saved);
    }, 30000);
  test(`v2 final page refuses ${table} before clearing or staging the target`, () => {
    const db = database([row("state_records")]);
    for (const sql of IMPORT_MIGRATION.statements) db.exec(sql);
    migrate(db);
    db.run(
      `INSERT INTO ${table} VALUES (${values.map(() => "?").join(",")})`,
      values,
    );
    const owner = new StateOwner(db, { now: () => 1000 });
    const page = {
      format: PAGE_FORMAT,
      page: 0,
      last: true,
      next: null,
      tables: empty(),
    };
    const snapshot = () =>
      db
        .all(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .map(({ name }) => [
          name,
          db.all(`SELECT * FROM ${String(name)} ORDER BY rowid`),
        ]);
    const before = snapshot(),
      changes = db.get("SELECT total_changes() AS n");
    let failure: unknown;
    try {
      restorePage(db, owner, page, limits);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      error: {
        code: "INPUT_INVALID",
      },
    });
    expect(String(failure)).toMatch(/newer Forge/i);
    expect(snapshot()).toEqual(before);
    expect(db.get("SELECT total_changes() AS n")).toEqual(changes);
    db.run(`DELETE FROM ${table}`);
    expect(() => restorePage(db, owner, page, limits)).not.toThrow();
  }, 30000);
}
const pageText = (tables: Record<string, Row[]>, next: string | null = null) =>
  JSON.stringify({
    format: PAGE_FORMAT,
    page: 0,
    last: next === null,
    next,
    tables,
  });
// Every page from the start: its number, and its rows in order.
function walk(
  db: SqlDatabase,
  budget: Parameters<typeof dumpPage>[2],
  table: string,
) {
  const seen: string[] = [];
  let cursor = "start";
  for (let n = 0; ; n += 1) {
    expect(n).toBeLessThan(20);
    const page = dumpPage(db, cursor, budget);
    expect(page.page).toBe(n);
    expect(bytes(page)).toBeLessThanOrEqual(Math.min(budget.pageBytes, CAP));
    seen.push(...page.tables[table]!.map((r) => String(r.key ?? r.subject)));
    if (page.next === null) return { pages: n + 1, seen };
    cursor = page.next;
  }
}

// Four columns carry open JSON and have the transport ceiling; every other string keeps its old one. The
// wide parse case uses a value that fits the 8 MiB text bound, since a value at the ceiling cannot.
for (const [table, column, cap] of [
  ["state_records", "body", CAP],
  ["state_events", "body", CAP],
  ["state_requests", "fingerprint", CAP],
  ["state_requests", "result", CAP],
  ["domain_cloud_command_receipts", "result", CAP],
  ["state_leases", "body", SCALAR],
  ["domain_cloud_requests", "fingerprint", SCALAR],
  ["domain_cloud_requests", "result", SCALAR],
  ["domain_cloud_requests", "outcome", SCALAR],
  ["state_records", "key", SCALAR],
  ["state_requests", "request_id", SCALAR],
] as const)
  test(`${table}.${column} holds ${cap} characters and refuses one more, out and in`, () => {
    const at = database([row(table, { [column]: "x".repeat(cap) })]);
    expect(dumpOf(at).tables[table]![0]![column]).toHaveLength(cap);
    const over = database([row(table, { [column]: "x".repeat(cap + 1) })]);
    expect(codeOf(() => dumpOf(over))).toBe("DUMP_UNSAFE_VALUE");
    const fits = cap === CAP ? cap - 4096 : cap;
    const parsed = parseDump(dumpText(table, { [column]: "x".repeat(fits) }));
    expect(parsed.tables[table]![0]![column]).toHaveLength(fits);
    expect(
      codeOf(() =>
        parseDump(dumpText(table, { [column]: "x".repeat(cap + 1) })),
      ),
    ).toBe("INPUT_INVALID");
  }, 60_000);

// A direct parseDump caller is bounded by bytes before JSON.parse builds anything: ASCII, and text whose
// UTF-16 length is small but whose UTF-8 size is not.
for (const [name, char, rows] of [
  ["ASCII", "x", 33],
  ["multibyte", "€", 11],
] as const)
  test(`parseDump refuses ${name} text over 8 MiB even when every cell is within its ceiling`, () => {
    const leases = Array.from(
      { length: rows },
      (_, i) =>
        row("state_leases", { subject: `s${i}`, body: char.repeat(SCALAR) })[1],
    );
    const text = pageText({ ...empty(), state_leases: leases });
    expect(new TextEncoder().encode(text).length).toBeGreaterThan(CAP);
    expect(codeOf(() => parseDump(text))).toBe("INPUT_INVALID");
  }, 30_000);

// The page is counted as the document it is: arrays, commas, metadata, the cursor, quoted and in UTF-8.
test("every complete page is within its byte budget, counted in UTF-8 with its envelope", () => {
  const rows = Array.from({ length: 12 }, (_, i) =>
    row("state_records", {
      key: `k${String(i).padStart(2, "0")}`,
      body: "€".repeat(150),
    }),
  );
  const { pages, seen } = walk(
    database(rows),
    { ...limits, pageBytes: 1600 },
    "state_records",
  );
  expect(pages).toBeGreaterThan(2);
  expect(seen).toEqual(rows.map(([, r]) => String(r.key)));
}, 30_000);

test("a page never exceeds the 8 MiB restore body, whatever page size is configured", () => {
  const rows = Array.from({ length: 40 }, (_, i) =>
    row("state_leases", {
      subject: `s${String(i).padStart(2, "0")}`,
      body: "x".repeat(SCALAR),
    }),
  );
  const huge = { ...limits, pageBytes: 64 * MIB, maxBytes: 64 * MIB };
  const { pages, seen } = walk(database(rows), huge, "state_leases");
  expect([pages > 1, seen.length]).toEqual([true, 40]);
}, 60_000);

// A row is never split, so one that cannot fit with its envelope is refused, never returned as a page.
for (const [name, body] of [
  ["plain", "a".repeat(2000)],
  ["quote heavy: 600 characters, 1,200 once quoted", '"'.repeat(600)],
  ["multibyte: 400 characters, 1,200 bytes", "€".repeat(400)],
] as const)
  test(`a first row that does not fit its page is DUMP_TOO_LARGE: ${name}`, () => {
    const db = database([row("state_records", { body })]);
    expect(
      codeOf(() => dumpPage(db, "start", { ...limits, pageBytes: 1024 })),
    ).toBe("DUMP_TOO_LARGE");
  }, 30_000);

const cursor = (over: object = {}) =>
  JSON.stringify({
    p: 1,
    t: 0,
    k: ["n", "k"],
    w: `${"0".repeat(32)}.${"1".padStart(19, "0")}`,
    ...over,
  });
for (const [name, text] of [
  ["a key part over its ceiling", cursor({ k: ["n", "k".repeat(SCALAR + 1)] })],
  ["a watermark with letters", cursor({ w: "1.x" })],
  ["a watermark with three parts", cursor({ w: "1.2.3" })],
  ["a watermark number over 19 digits", cursor({ w: `${"1".repeat(20)}.1` })],
  [
    "text over the cursor ceiling",
    `${JSON.stringify({ p: 0, t: 0, k: null, w: "" })}${" ".repeat(3_145_828)}`,
  ],
] as const)
  test(`a cursor is INPUT_INVALID: ${name}`, () => {
    expect(codeOf(() => dumpPage(database(), text, limits))).toBe(
      "INPUT_INVALID",
    );
  }, 30_000);

test("the empty start watermark is accepted", () => {
  const db = database([row("state_records")]);
  const start = JSON.stringify({ p: 0, t: 0, k: null, w: "" });
  expect(dumpPage(db, start, limits).tables.state_records).toHaveLength(1);
}, 30_000);

for (const [length, code] of [
  [3_145_827, undefined],
  [3_145_828, "INPUT_INVALID"],
] as const)
  test(`a page's next of ${length} characters is ${code ?? "accepted"} by the parser`, () => {
    expect(codeOf(() => parseDump(pageText(empty(), "n".repeat(length))))).toBe(
      code,
    );
  }, 30_000);

const NOW = `${"0".repeat(32)}.${"0".repeat(19)}`;
for (const revision of [0, 9, 10, 999])
  test(`export counter ${revision} keeps continuation bytes fixed across restores`, () => {
    const db = database([
      row("state_records", { key: "a", body: "x".repeat(700) }),
      row("state_records", { key: "b", body: "x".repeat(700) }),
    ]);
    const budget = { ...limits, pageBytes: 1600 };
    const before = dumpPage(db, "start", budget);
    expect(before.next).not.toBeNull();
    db.run("UPDATE domain_cloud_export SET revision=?", [revision]);
    const after = dumpPage(db, "start", budget);
    const marker = (JSON.parse(after.next!) as { w: string }).w;
    expect(marker).toBe(
      `${"0".repeat(32)}.${String(revision).padStart(19, "0")}`,
    );
    expect(bytes(after)).toBe(bytes(before));
    expect(after.tables).toEqual(before.tables);
  }, 30_000);
const forged = (over: object = {}) =>
  JSON.stringify({ p: 1, t: 0, k: null, w: NOW, ...over });
// Every page request is checked against the project limits, so a forged continuation cursor cannot reach
// rows that cursor=start refuses.
for (const [name, small, rows] of [
  [
    "bytes",
    { maxBytes: 1000 },
    [row("state_records", { body: "x".repeat(2000) })],
  ],
  [
    "rows",
    { maxRows: 2 },
    ["a", "b", "c"].map((key) => row("state_records", { key })),
  ],
] as const)
  test(`an oversized project (${name}) refuses cursor=start and a forged continuation alike`, () => {
    const db = database([...rows]);
    for (const text of ["start", forged()])
      expect(codeOf(() => dumpPage(db, text, { ...limits, ...small }))).toBe(
        "DUMP_TOO_LARGE",
      );
  }, 30_000);

// A page that is empty or final is a page too: its whole document is within the budget, or it is refused.
test("an empty or final page over the budget is DUMP_TOO_LARGE, and a final page within it is accepted", () => {
  const tiny = { ...limits, pageBytes: 100 };
  const past = JSON.stringify({
    p: 1,
    t: 5,
    k: ["z"],
    w: `${"0".repeat(32)}.${"1".padStart(19, "0")}`,
  });
  const one = database([row("domain_cloud_requests")]);
  expect(codeOf(() => dumpPage(undefined, "start", tiny))).toBe(
    "DUMP_TOO_LARGE",
  );
  expect(codeOf(() => dumpPage(database(), "start", tiny))).toBe(
    "DUMP_TOO_LARGE",
  );
  expect(codeOf(() => dumpPage(one, past, tiny))).toBe("DUMP_TOO_LARGE");
  const empty = dumpPage(one, past, limits);
  expect(empty.next).toBeNull();
  expect(
    codeOf(() => dumpPage(one, past, { ...limits, pageBytes: bytes(empty) })),
  ).toBeUndefined();
  expect(
    codeOf(() =>
      dumpPage(one, past, { ...limits, pageBytes: bytes(empty) - 1 }),
    ),
  ).toBe("DUMP_TOO_LARGE");
}, 30_000);

// The budget is an inclusive bound: a page of exactly its budget is accepted, one byte less cuts it.
test("a page that lands exactly on its budget is accepted and one byte under cuts it, final and continuation", () => {
  const rows = Array.from({ length: 5 }, (_, i) =>
    row("state_records", { key: `k${i}`, body: "b".repeat(100) }),
  );
  const db = database(rows);
  const first = (pageBytes: number) =>
    dumpPage(db, "start", { ...limits, pageBytes });
  const count = (page: ReturnType<typeof first>) =>
    page.tables.state_records!.length;
  const whole = first(CAP);
  expect([count(whole), whole.next]).toEqual([5, null]);
  expect(first(bytes(whole))).toEqual(whole);
  const cut = first(bytes(whole) - 1);
  expect(cut.next).not.toBeNull();
  expect(count(cut)).toBeLessThan(5);
  expect(bytes(cut)).toBeLessThanOrEqual(bytes(whole) - 1);
  expect(first(bytes(cut))).toEqual(cut);
  expect(count(first(bytes(cut) - 1))).toBeLessThan(count(cut));
}, 30_000);

test("a cursor key part of exactly 262,144 characters is accepted", () => {
  const text = JSON.stringify({
    p: 1,
    t: 0,
    k: ["n", "k".repeat(SCALAR)],
    w: NOW,
  });
  expect(codeOf(() => dumpPage(database(), text, limits))).toBeUndefined();
}, 30_000);

// A whole dump is measured as it is sent: a control character is one stored byte and six serialized.
test("a whole dump whose escaped size is over the 8 MiB restore body is DUMP_TOO_LARGE, and one under it is served", () => {
  const big = database(
    ["a", "b"].map((key) =>
      row("state_records", { key, body: "\u0001".repeat(1_400_000) }),
    ),
  );
  expect(codeOf(() => dumpOf(big, limits))).toBe("DUMP_TOO_LARGE");
  const ok = database([
    row("state_records", { body: "\u0001".repeat(500_000) }),
  ]);
  expect(dumpOf(ok, limits).tables.state_records).toHaveLength(1);
}, 60_000);
