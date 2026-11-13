// An independent oracle for the dump page budget, for the budget journeys of conformance.ts. It cuts rows into pages by
// the rule docs/reference/cloud.md states, with plain serialization, and never calls cloud/src/dump.ts or its size
// helpers: expected pages come from accepted rows read with SQL. Test code only: the Worker never imports it.
import { createHash } from "node:crypto";
import { PAGE, SHAPE, type Tables } from "./max-source.ts";

const part = (at: 0 | 1): Record<string, string[]> =>
  Object.fromEntries(
    Object.entries(SHAPE).map(([table, shape]) => [
      table,
      shape[at].split(", "),
    ]),
  );
const KEYS = part(1);

export interface Page {
  format: string;
  page: number;
  last: boolean;
  next: string | null;
  tables: Tables;
}
/** How a cut counts one value: the real rule is UTF-8 bytes of its JSON; the other is the counterfactual. */
export type Measure = (value: unknown) => number;
export const utf8: Measure = (value) =>
  Buffer.byteLength(JSON.stringify(value));
export const utf16: Measure = (value) => JSON.stringify(value).length;

/** JSON byte length of a parsed page, without allocating its complete serialization. */
export function pageBytes(value: unknown): number {
  if (Array.isArray(value))
    return (
      2 +
      Math.max(0, value.length - 1) +
      (value as unknown[]).reduce<number>((n, item) => n + pageBytes(item), 0)
    );
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    return (
      2 +
      Math.max(0, entries.length - 1) +
      entries.reduce(
        (n, [key, item]) =>
          n + Buffer.byteLength(JSON.stringify(key)) + 1 + pageBytes(item),
        0,
      )
    );
  }
  return Buffer.byteLength(JSON.stringify(value));
}

const blank = (): Tables =>
  Object.fromEntries(Object.keys(SHAPE).map((table) => [table, []]));
const pageOf = (
  page: number,
  last: boolean,
  next: string | null,
  tables: Tables,
): Page => ({ format: PAGE, page, last, next, tables });
const rowsOf = (tables: Tables) =>
  Object.entries(tables).flatMap(([table, rows], t) =>
    rows.map((row) => ({ table, t, row })),
  );
type Entry = ReturnType<typeof rowsOf>[number];
// A restored source starts a fresh epoch at revision zero. Its random epoch has a fixed width.
const RESTORED_MARK = `${"0".repeat(32)}.0`;
const cursorOf = (entry: Entry, p: number, w: string): string =>
  JSON.stringify({
    p,
    t: entry.t,
    k: KEYS[entry.table]!.map((column) => entry.row[column]),
    w,
  });

/** How many rows come before and include the last lease row in dump order. */
export const leaseBoundary = (tables: Tables): number =>
  tables.state_records!.length +
  tables.state_events!.length +
  tables.state_leases!.length;

/** The page document of `tables` as one final page: page 0, last, no cursor. */
export const finalPage = (tables: Tables): Page =>
  pageOf(0, true, null, tables);

/** Page 0 holding the first `count` rows in dump order, continued by the cursor after the last of them. */
export function pageThrough(tables: Tables, count: number): Page {
  const entries = rowsOf(tables).slice(0, count);
  const rows = blank();
  for (const { table, row } of entries) rows[table]!.push(row);
  return pageOf(0, false, cursorOf(entries.at(-1)!, 1, RESTORED_MARK), rows);
}

/**
 * The pages of `tables` under `budget`: a row joins the page when the whole page document with it, its commas and the
 * envelope (arrays, metadata and the cursor after it, or the last-page form for the final row) is at most the budget.
 * `measure` and `envelope: false` are the counterfactual rules, used only to show a fixture can tell them apart.
 */
export function* eachCutPage(
  tables: Tables,
  budget: number,
  measure: Measure = utf8,
  envelope = true,
): Generator<Page> {
  const rows = rowsOf(tables);
  const w = RESTORED_MARK;
  let page = 0;
  let held = blank();
  let used = 0;
  let here: string | null = null;
  for (const [i, entry] of rows.entries())
    for (;;) {
      const last = i === rows.length - 1;
      const key = cursorOf(entry, page + 1, w);
      const added =
        measure(entry.row) + (held[entry.table]!.length > 0 ? 1 : 0);
      const shell = envelope
        ? measure(pageOf(page, last, last ? null : key, blank()))
        : 0;
      if (shell + used + added <= budget) {
        held[entry.table]!.push(entry.row);
        used += added;
        here = key;
        break;
      }
      if (used === 0) throw new Error(`a row does not fit ${budget} bytes`);
      yield pageOf(page, false, here, held);
      page += 1;
      held = blank();
      used = 0;
      here = null;
    }
  yield pageOf(page, true, null, held);
}

export function cutPages(
  tables: Tables,
  budget: number,
  measure: Measure = utf8,
  envelope = true,
): Page[] {
  return Array.from(eachCutPage(tables, budget, measure, envelope));
}

const TIME = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g;
/**
 * A running digest of every column of every row, per table, in the order the rows arrive; empty tables count too.
 * With `stamped`, each clock time is replaced by a fixed word first, for rows written at different times.
 */
export function digester(stamped = false) {
  const state = Object.fromEntries(
    Object.keys(SHAPE).map((table) => [
      table,
      { hash: createHash("sha256"), rows: 0 },
    ]),
  );
  return {
    add(table: string, rows: readonly Record<string, unknown>[]): void {
      const entry = state[table]!;
      for (const row of rows) {
        const text = JSON.stringify(row);
        entry.hash.update(stamped ? text.replace(TIME, "<time>") : text);
        entry.hash.update("\n");
        entry.rows += 1;
      }
    },
    done: (): Record<string, string> =>
      Object.fromEntries(
        Object.entries(state).map(([table, { hash, rows }]) => [
          table,
          `${rows} rows ${hash.digest("hex")}`,
        ]),
      ),
  };
}
export function digestOf(tables: Tables, stamped = false) {
  const digest = digester(stamped);
  for (const [table, rows] of Object.entries(tables)) digest.add(table, rows);
  return digest.done();
}

/** 500 UTF-16 units that a cursor must escape twice: quote, backslash, U+0001, two BMP characters and an astral one. */
export const longSubject = (): string =>
  '"\\\u0001\u00e9\u20ac\u{1F600}'.repeat(71) + '"\\\u0001';

const WIDTH: Record<string, number> = {
  namespace: 132,
  key: 500,
  subject: 500,
  request_id: 128,
};
/**
 * The largest request URL, in UTF-8 bytes, a dump continuation can need for each table's key shape: the longest legal
 * parts of three-byte characters (nine bytes each once escaped), a safe integer in the page and the sequence, a
 * 64-character project name and a watermark of two 19-digit numbers.
 */
export function cursorBounds(origin: string): Record<string, number> {
  const w = `${"f".repeat(32)}.${"9".repeat(19)}`;
  return Object.fromEntries(
    Object.keys(SHAPE).map((table, t) => {
      const k = KEYS[table]!.map((column) =>
        column === "sequence"
          ? Number.MAX_SAFE_INTEGER
          : "\u20ac".repeat(WIDTH[column]!),
      );
      const cursor = JSON.stringify({ p: Number.MAX_SAFE_INTEGER, t, k, w });
      return [
        table,
        Buffer.byteLength(
          `${origin}/p/${"a".repeat(64)}/dump?cursor=${encodeURIComponent(cursor)}`,
        ),
      ];
    }),
  );
}
