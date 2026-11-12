// Column, cursor and page boundaries of the dump, on plain tables: no Worker, no state owner.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  dumpOf,
  dumpPage,
  limitsFrom,
  PAGE_FORMAT,
  parseDump,
} from "../../cloud/src/dump.ts";
import type { SqlDatabase, SqlRow } from "../../src/ports/store.ts";

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
    db.run(
      `CREATE TABLE ${table} (${Object.entries(sample)
        .map(([c, v]) => `${c} ${typeof v === "number" ? "INTEGER" : "TEXT"}`)
        .join(", ")}${key})`,
    );
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
    return (error as { error?: { code: string } }).error?.code;
  }
  return undefined;
};
const bytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;
const dumpText = (table: string, over: Row) =>
  JSON.stringify({
    format: "forge-cloud-dump/1",
    tables: { ...empty(), [table]: [row(table, over)[1]] },
  });
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

test("the empty start watermark is accepted", () => {
  const db = database([row("state_records")]);
  const start = JSON.stringify({ p: 0, t: 0, k: null, w: "" });
  expect(dumpPage(db, start, limits).tables.state_records).toHaveLength(1);
}, 30_000);

for (const [length, code] of [
  [3_145_814, undefined],
  [3_145_815, "INPUT_INVALID"],
] as const)
  test(`a page's next of ${length} characters is ${code ?? "accepted"} by the parser`, () => {
    expect(codeOf(() => parseDump(pageText(empty(), "n".repeat(length))))).toBe(
      code,
    );
  }, 30_000);
