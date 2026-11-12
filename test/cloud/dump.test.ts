// Column and page boundaries of the dump, on plain tables: no Worker, no state owner.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  dumpOf,
  dumpPage,
  limitsFrom,
  PAGE_FORMAT,
  parseDump,
  type Limits,
} from "../../cloud/src/dump.ts";
import type { SqlDatabase, SqlRow } from "../../src/ports/store.ts";

const MIB = 1024 * 1024;
const SCALAR = 262_144;
const CAP = 8 * MIB;
const limits: Limits = { ...limitsFrom({}), maxRows: 100 };
type Row = Record<string, string | number>;
const ROW: Record<string, Row> = {
  state_records: { namespace: "n", key: "k", revision: 1, body: "{}" },
  state_events: { sequence: 1, namespace: "n", key: "k", body: "{}" },
  state_leases: { namespace: "n", subject: "s", generation: 1, body: "{}" },
  state_requests: {
    namespace: "n",
    request_id: "r",
    fingerprint: "{}",
    result: "{}",
  },
  domain_cloud_requests: {
    request_id: "r",
    fingerprint: "{}",
    outcome: "ok",
    result: "{}",
  },
};
const KEY: Record<string, string> = {
  state_records: "PRIMARY KEY (namespace, key)",
  state_events: "",
  state_leases: "PRIMARY KEY (namespace, subject)",
  state_requests: "PRIMARY KEY (namespace, request_id)",
  domain_cloud_requests: "",
};
const empty = (): Record<string, Row[]> =>
  Object.fromEntries(Object.keys(ROW).map((table) => [table, []]));

function database(rows: [string, Row][] = []) {
  const db = new Database(":memory:");
  for (const [table, row] of Object.entries(ROW))
    db.run(
      `CREATE TABLE ${table} (${Object.keys(row)
        .map((c) => `${c} ${typeof row[c] === "number" ? "INTEGER" : "TEXT"}`)
        .join(", ")}${KEY[table] ? `, ${KEY[table]}` : ""})`,
    );
  for (const [table, row] of rows)
    db.run(
      `INSERT INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.keys(
        row,
      )
        .map(() => "?")
        .join(", ")})`,
      Object.values(row),
    );
  const sql: SqlDatabase = {
    exec: (statement) => {
      db.run(statement);
    },
    run: (statement, params = []) =>
      db.query(statement).run(...(params as never[])),
    all: (statement, params = []) =>
      db.query(statement).all(...(params as never[])) as SqlRow[],
    get: (statement, params = []) =>
      (db.query(statement).get(...(params as never[])) ?? undefined) as
        SqlRow | undefined,
    transaction: (body) => db.transaction(body)(),
  };
  return sql;
}
const withValue = (
  table: string,
  column: string,
  value: string,
): [string, Row] => [table, { ...ROW[table]!, [column]: value }];
const codeOf = (body: () => unknown): string | undefined => {
  try {
    body();
  } catch (error) {
    return (error as { error?: { code: string } }).error?.code;
  }
  return undefined;
};
const bytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;
const paged = (tables: Record<string, Row[]>, next: string | null = null) => ({
  format: PAGE_FORMAT,
  page: 0,
  last: next === null,
  next,
  tables,
});

// The four columns that carry open JSON have the transport ceiling; every other string keeps its old one.
const WIDE = [
  ["state_records", "body"],
  ["state_events", "body"],
  ["state_requests", "fingerprint"],
  ["state_requests", "result"],
] as const;
const NARROW = [
  ["state_leases", "body"],
  ["domain_cloud_requests", "fingerprint"],
  ["domain_cloud_requests", "result"],
  ["domain_cloud_requests", "outcome"],
  ["state_records", "key"],
  ["state_requests", "request_id"],
] as const;

for (const [table, column] of WIDE)
  test(`${table}.${column} exports up to 8,388,608 characters and refuses one more`, () => {
    const at = database([withValue(table, column, "x".repeat(CAP))]);
    expect(dumpOf(at).tables[table]![0]![column]).toHaveLength(CAP);
    const over = database([withValue(table, column, "x".repeat(CAP + 1))]);
    expect(codeOf(() => dumpOf(over))).toBe("DUMP_UNSAFE_VALUE");
  }, 60_000);

for (const [table, column] of WIDE)
  test(`${table}.${column} parses a value that fits the restore body and refuses one over its ceiling`, () => {
    const fits = { ...ROW[table]!, [column]: "x".repeat(CAP - 4096) };
    const doc = (row: Row) =>
      JSON.stringify({
        format: "forge-cloud-dump/1",
        tables: { ...empty(), [table]: [row] },
      });
    const parsed = parseDump(doc(fits)) as { tables: Record<string, Row[]> };
    expect(parsed.tables[table]![0]![column]).toHaveLength(CAP - 4096);
    expect(
      codeOf(() => parseDump(doc({ ...fits, [column]: "x".repeat(CAP + 1) }))),
    ).toBe("INPUT_INVALID");
  }, 60_000);

for (const [table, column] of NARROW)
  test(`${table}.${column} keeps its 262,144 character ceiling, on the way out and on the way in`, () => {
    const at = database([withValue(table, column, "x".repeat(SCALAR))]);
    expect(dumpOf(at).tables[table]![0]![column]).toHaveLength(SCALAR);
    const over = database([withValue(table, column, "x".repeat(SCALAR + 1))]);
    expect(codeOf(() => dumpOf(over))).toBe("DUMP_UNSAFE_VALUE");
    const doc = (value: string) =>
      JSON.stringify({
        format: "forge-cloud-dump/1",
        tables: { ...empty(), [table]: [{ ...ROW[table]!, [column]: value }] },
      });
    expect(codeOf(() => parseDump(doc("x".repeat(SCALAR))))).toBeUndefined();
    expect(codeOf(() => parseDump(doc("x".repeat(SCALAR + 1))))).toBe(
      "INPUT_INVALID",
    );
  }, 30_000);

// A direct parseDump caller is bounded by bytes before JSON.parse builds anything: ASCII, and text whose
// UTF-16 length is small but whose UTF-8 size is not.
for (const [name, char, rows] of [
  ["ASCII", "x", 33],
  ["multibyte", "€", 11],
] as const)
  test(`parseDump refuses ${name} text over 8 MiB even when every cell is within its ceiling`, () => {
    const leases = Array.from({ length: rows }, (_, i) => ({
      ...ROW.state_leases!,
      subject: `s${i}`,
      body: char.repeat(SCALAR),
    }));
    const text = JSON.stringify(paged({ ...empty(), state_leases: leases }));
    expect(new TextEncoder().encode(text).length).toBeGreaterThan(CAP);
    expect(codeOf(() => parseDump(text))).toBe("INPUT_INVALID");
  }, 30_000);

// The page is counted as the document it is: arrays, commas, metadata, the cursor, quoted and in UTF-8.
test("every complete page is within its byte budget, counted in UTF-8 with its envelope", () => {
  const rows = Array.from({ length: 12 }, (_, i): [string, Row] => [
    "state_records",
    {
      ...ROW.state_records!,
      key: `k${String(i).padStart(2, "0")}`,
      body: "€".repeat(150),
    },
  ]);
  const db = database(rows);
  const budget = { ...limits, pageBytes: 1600 };
  const seen: string[] = [];
  let cursor = "start";
  for (let pages = 0; ; pages += 1) {
    expect(pages).toBeLessThan(20);
    const page = dumpPage(db, cursor, budget);
    expect(page.page).toBe(pages);
    expect(bytes(page)).toBeLessThanOrEqual(budget.pageBytes);
    seen.push(...page.tables.state_records!.map((row) => String(row.key)));
    if (page.next === null) {
      expect(pages).toBeGreaterThan(2);
      break;
    }
    cursor = page.next;
  }
  expect(seen).toEqual(rows.map(([, row]) => String(row.key)));
}, 30_000);

test("a page never exceeds the 8 MiB restore body, whatever page size is configured", () => {
  const db = database(
    Array.from({ length: 40 }, (_, i): [string, Row] => [
      "state_leases",
      {
        ...ROW.state_leases!,
        subject: `s${String(i).padStart(2, "0")}`,
        body: "x".repeat(SCALAR),
      },
    ]),
  );
  const huge = { ...limits, pageBytes: 64 * MIB, maxBytes: 64 * MIB };
  let cursor = "start";
  let count = 0;
  for (let pages = 0; ; pages += 1) {
    expect(pages).toBeLessThan(10);
    const page = dumpPage(db, cursor, huge);
    expect(bytes(page)).toBeLessThanOrEqual(CAP);
    count += page.tables.state_leases!.length;
    if (page.next === null) {
      expect(pages).toBeGreaterThan(0);
      break;
    }
    cursor = page.next;
  }
  expect(count).toBe(40);
}, 60_000);

// A row is never split, so one that cannot fit with its envelope is refused, never returned as a page.
for (const [name, body] of [
  ["plain", "a".repeat(2000)],
  ["quote heavy: 600 characters, 1,200 once quoted", '"'.repeat(600)],
  ["multibyte: 400 characters, 1,200 bytes", "€".repeat(400)],
] as const)
  test(`a first row that does not fit its page is DUMP_TOO_LARGE: ${name}`, () => {
    const db = database([withValue("state_records", "body", body)]);
    expect(
      codeOf(() => dumpPage(db, "start", { ...limits, pageBytes: 1024 })),
    ).toBe("DUMP_TOO_LARGE");
  }, 30_000);

const cursor = (over: object = {}) =>
  JSON.stringify({ p: 1, t: 0, k: ["n", "k"], w: "1.1", ...over });
for (const [name, text] of [
  ["a key part over its ceiling", cursor({ k: ["n", "k".repeat(SCALAR + 1)] })],
  ["a watermark with letters", cursor({ w: "1.x" })],
  ["a watermark with three parts", cursor({ w: "1.2.3" })],
  ["a watermark number over 19 digits", cursor({ w: `${"1".repeat(20)}.1` })],
  [
    "text over the cursor ceiling",
    `${JSON.stringify({ p: 0, t: 0, k: null, w: "" })}${" ".repeat(3_145_815)}`,
  ],
] as const)
  test(`a cursor is INPUT_INVALID: ${name}`, () => {
    expect(codeOf(() => dumpPage(database(), text, limits))).toBe(
      "INPUT_INVALID",
    );
  }, 30_000);

test("the empty start watermark is accepted, and a page's next is bounded in the parser", () => {
  const db = database([["state_records", ROW.state_records!]]);
  expect(
    dumpPage(db, JSON.stringify({ p: 0, t: 0, k: null, w: "" }), limits).tables
      .state_records,
  ).toHaveLength(1);
  const doc = (next: string) => JSON.stringify(paged(empty(), next));
  expect(codeOf(() => parseDump(doc("n".repeat(3_145_814))))).toBeUndefined();
  expect(codeOf(() => parseDump(doc("n".repeat(3_145_815))))).toBe(
    "INPUT_INVALID",
  );
}, 30_000);
