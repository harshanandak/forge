// A project as plain JSON: its issues (state_records), leases, events and receipts, and nothing else.
// Device tokens and their hashes are never part of a dump. The database image is never used.
// Every value is a string or a safe integer; anything else is refused on the way out and on the way in.
import { ForgeFailure } from "../../src/contract/failure.ts";
import {
  RestoreConsistencyFailure,
  verifyEventDerivedState,
} from "../../src/core/state/index.ts";
import {
  validateForgeError,
  validateLeaseRecord,
} from "../../src/generated/validators.ts";
import type { SqlDatabase, SqlRow } from "../../src/ports/store.ts";

export const DUMP_FORMAT = "forge-cloud-dump/1";

// `keys` is each table's primary key in order: dump order, and the position a page cursor resumes after.
const TABLES: Record<string, { columns: string[]; keys: string[] }> = {
  state_records: {
    columns: ["namespace", "key", "revision", "body"],
    keys: ["namespace", "key"],
  },
  state_events: {
    columns: ["sequence", "namespace", "key", "body"],
    keys: ["sequence"],
  },
  state_leases: {
    columns: ["namespace", "subject", "generation", "body"],
    keys: ["namespace", "subject"],
  },
  state_requests: {
    columns: ["namespace", "request_id", "fingerprint", "result"],
    keys: ["namespace", "request_id"],
  },
  domain_cloud_requests: {
    columns: ["request_id", "fingerprint", "outcome", "result"],
    keys: ["request_id"],
  },
};

export const PAGE_FORMAT = "forge-cloud-dump-page/1";

// Limits on a dump, on the way out and on the way in. The depth is exactly what the format needs:
// document, tables, rows array, row. The caps keep a hostile or broken document from filling the isolate.
const MAX_DEPTH = 4;
const MAX_ROWS_PER_TABLE = 50_000;
const MAX_VALUE_LENGTH = 262_144;
// A whole (unpaged) dump stays well under the 8 MiB restore body: JSON escaping can double its size.
const WHOLE_DUMP_BYTES = 3 * 1024 * 1024;
// Rows are read this many at a time, so a page never holds more than a page plus one batch.
const BATCH = 16;

/** Page size and project size, in bytes. A deploy uses the defaults; the test config lowers them. */
export interface Limits {
  readonly pageBytes: number;
  readonly maxBytes: number;
}
export function limitsFrom(env: unknown): Limits {
  const vars = (env ?? {}) as Record<string, unknown>;
  const read = (name: string, fallback: number): number => {
    const value = Number(vars[name]);
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
  };
  return {
    pageBytes: read("DUMP_PAGE_BYTES", 4 * 1024 * 1024),
    maxBytes: read("DUMP_MAX_BYTES", 16 * 1024 * 1024),
  };
}

type Row = Record<string, string | number>;
type Key = (string | number)[];
export interface Dump {
  format: string;
  tables: Record<string, Row[]>;
}
/** A piece of a project: whole tables or the part of one that fits, in dump order. */
export interface Page extends Dump {
  page: number;
  last: boolean;
  next: string | null;
}
interface Cursor {
  p: number;
  t: number;
  k: Key | null;
}

const invalid = (message: string): ForgeFailure =>
  new ForgeFailure({ code: "INPUT_INVALID", message, retry: "never" });
const emptyTables = (): Record<string, Row[]> =>
  Object.fromEntries(Object.keys(TABLES).map((table) => [table, []]));
const counts = (tables: Record<string, Row[]>): Record<string, number> =>
  Object.fromEntries(
    Object.entries(tables).map(([table, rows]) => [table, rows.length]),
  );

// The stored size of every row, summed by SQLite, so a size check loads no row.
function assertSize(
  db: SqlDatabase,
  max: number,
  code: string,
  what: string,
  hint = "",
): void {
  let bytes = 0;
  for (const [table, { columns }] of Object.entries(TABLES))
    bytes += Number(
      db.get(
        `SELECT COALESCE(SUM(${columns.map((column) => `LENGTH(CAST(${column} AS BLOB))`).join(" + ")}), 0) AS bytes FROM ${table}`,
      )!.bytes,
    );
  if (bytes > max)
    throw new ForgeFailure({
      code,
      message: `${what} holds ${bytes} bytes, over the ${max} byte limit.${hint}`,
      retry: "never",
    });
}

function rowOf(table: string, row: SqlRow): Row {
  return Object.fromEntries(
    TABLES[table]!.columns.map((column) => {
      const value = row[column];
      if (
        (typeof value === "string" && value.length <= MAX_VALUE_LENGTH) ||
        (typeof value === "number" && Number.isSafeInteger(value))
      )
        return [column, value];
      throw new ForgeFailure({
        code: "DUMP_UNSAFE_VALUE",
        message: `${table}.${column} holds a value that is not a string (up to ${MAX_VALUE_LENGTH} characters) or a safe integer`,
        retry: "never",
      });
    }),
  );
}

// Every row from table index `from`, after the key `after` in that table, in dump order. Rows come from
// SQLite a batch at a time, so a caller that stops early never loads the rest.
function* rowsFrom(
  db: SqlDatabase,
  from: number,
  after: Key | null,
): Generator<{ table: number; row: Row }> {
  const names = Object.keys(TABLES);
  let key = after;
  for (let t = from; t < names.length; t += 1, key = null) {
    const table = names[t]!;
    const { keys } = TABLES[table]!;
    for (;;) {
      const found = db.all(
        `SELECT ${TABLES[table]!.columns.join(", ")} FROM ${table}${key === null ? "" : ` WHERE (${keys.join(", ")}) > (${keys.map(() => "?").join(", ")})`} ORDER BY ${keys.join(", ")} LIMIT ${BATCH}`,
        key ?? [],
      );
      for (const stored of found) {
        const row = rowOf(table, stored);
        yield { table: t, row };
        key = keys.map((column) => row[column]!);
      }
      if (found.length < BATCH) break;
    }
  }
}

/** The whole dump of a project; undefined means it was never provisioned, so it has no database. */
export function dumpOf(db: SqlDatabase | undefined, limits?: Limits): Dump {
  if (db === undefined) return { format: DUMP_FORMAT, tables: emptyTables() };
  if (limits !== undefined)
    assertSize(
      db,
      Math.min(limits.maxBytes, WHOLE_DUMP_BYTES),
      "DUMP_TOO_LARGE",
      "The project",
      " Dump it in pages with GET dump?cursor=start.",
    );
  const tables = emptyTables();
  const names = Object.keys(TABLES);
  for (const { table, row } of rowsFrom(db, 0, null)) {
    const rows = tables[names[table]!]!;
    if (rows.length >= MAX_ROWS_PER_TABLE)
      throw new ForgeFailure({
        code: "DUMP_TOO_LARGE",
        message: `${names[table]} has more than ${MAX_ROWS_PER_TABLE} rows`,
        retry: "never",
      });
    rows.push(row);
  }
  return { format: DUMP_FORMAT, tables };
}

function parseCursor(text: string): Cursor {
  if (text === "start") return { p: 0, t: 0, k: null };
  const bad = (): ForgeFailure =>
    invalid("The cursor must be start or a cursor a page returned");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw bad();
  }
  const cursor = value as { p?: unknown; t?: unknown; k?: unknown } | null;
  const table = Object.values(TABLES)[Number(cursor?.t)];
  if (
    cursor === null ||
    typeof cursor !== "object" ||
    Object.keys(cursor).sort().join() !== "k,p,t" ||
    !Number.isSafeInteger(cursor.p) ||
    (cursor.p as number) < 0 ||
    table === undefined ||
    (cursor.k !== null &&
      (!Array.isArray(cursor.k) ||
        cursor.k.length !== table.keys.length ||
        cursor.k.some(
          (part: unknown) =>
            typeof part !== "string" &&
            !(typeof part === "number" && Number.isSafeInteger(part)),
        )))
  )
    throw bad();
  return cursor as Cursor;
}

const pageOf = (
  page: number,
  tables: Record<string, Row[]>,
  next: Cursor | null,
): Page => ({
  format: PAGE_FORMAT,
  page,
  last: next === null,
  next: next === null ? null : JSON.stringify(next),
  tables,
});

/** One page of a project, at most about `limits.pageBytes` of rows (one row is never split). */
export function dumpPage(
  db: SqlDatabase | undefined,
  cursorText: string,
  limits: Limits,
): Page {
  const from = parseCursor(cursorText);
  const tables = emptyTables();
  if (db === undefined) return pageOf(from.p, tables, null);
  if (cursorText === "start")
    assertSize(db, limits.maxBytes, "DUMP_TOO_LARGE", "The project");
  const names = Object.keys(TABLES);
  let used = 0;
  let next: Cursor = { p: from.p + 1, t: from.t, k: from.k };
  for (const { table, row } of rowsFrom(db, from.t, from.k)) {
    const size = new TextEncoder().encode(JSON.stringify(row)).length;
    if (used > 0 && used + size > limits.pageBytes)
      return pageOf(from.p, tables, next);
    tables[names[table]!]!.push(row);
    used += size;
    next = {
      p: from.p + 1,
      t: table,
      k: TABLES[names[table]!]!.keys.map((column) => row[column]!),
    };
  }
  return pageOf(from.p, tables, null);
}

// One pass over the text, before JSON.parse builds anything: refuses nesting deeper than the format has.
function checkDepth(text: string): void {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (char === "\\") i += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{" || char === "[") {
      depth += 1;
      if (depth > MAX_DEPTH)
        throw invalid(`The dump nests deeper than ${MAX_DEPTH} levels`);
    } else if (char === "}" || char === "]") depth -= 1;
  }
}

/** Checks a dump or a dump page strictly and returns it with every row in column order. */
export function parseDump(text: string): Dump | Page {
  checkDepth(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid("The dump must be JSON");
  }
  const document = parsed as Record<string, unknown> | null;
  if (document === null || typeof document !== "object")
    throw invalid("The dump must be a JSON object");
  const paged = document.format === PAGE_FORMAT;
  if (
    Object.keys(document).sort().join() !==
    (paged ? "format,last,next,page,tables" : "format,tables")
  )
    throw invalid(
      paged
        ? "A dump page must have exactly format, page, last, next and tables"
        : "The dump must have exactly format and tables",
    );
  if (!paged && document.format !== DUMP_FORMAT)
    throw invalid(`The dump format must be ${DUMP_FORMAT}`);
  if (
    paged &&
    (!Number.isSafeInteger(document.page) ||
      (document.page as number) < 0 ||
      document.last !== (document.next === null) ||
      (document.next !== null && typeof document.next !== "string"))
  )
    throw invalid(
      "A dump page needs a page number and next (null on the last)",
    );
  const given = document.tables as Record<string, unknown> | null;
  if (given === null || typeof given !== "object" || Array.isArray(given))
    throw invalid("The dump needs a tables object");
  const names = Object.keys(TABLES);
  if (Object.keys(given).sort().join() !== [...names].sort().join())
    throw invalid(`The dump tables must be exactly ${names.join(", ")}`);
  const tables: Record<string, Row[]> = {};
  for (const [table, { columns }] of Object.entries(TABLES)) {
    const rows = given[table];
    if (!Array.isArray(rows)) throw invalid(`${table} must be an array`);
    // A page is bounded by its bytes (the restore body limit), a whole dump by its rows.
    if (!paged && rows.length > MAX_ROWS_PER_TABLE)
      throw invalid(`${table} has more than ${MAX_ROWS_PER_TABLE} rows`);
    tables[table] = (rows as Record<string, unknown>[]).map((row) => {
      if (
        row === null ||
        typeof row !== "object" ||
        Object.keys(row).sort().join() !== [...columns].sort().join()
      )
        throw invalid(`A ${table} row must have exactly ${columns.join(", ")}`);
      return Object.fromEntries(
        columns.map((column) => {
          const value = row[column];
          if (
            (typeof value === "string" && value.length <= MAX_VALUE_LENGTH) ||
            (typeof value === "number" && Number.isSafeInteger(value))
          )
            return [column, value];
          throw invalid(
            `${table}.${column} must be a string (up to ${MAX_VALUE_LENGTH} characters) or a safe integer (53 bits)`,
          );
        }),
      );
    });
  }
  return paged
    ? {
        format: PAGE_FORMAT,
        page: document.page as number,
        last: document.last as boolean,
        next: document.next as string | null,
        tables,
      }
    : { format: DUMP_FORMAT, tables };
}

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const rejectedRow = (table: string, key: string): ForgeFailure =>
  new ForgeFailure({
    code: "RESTORE_INVALID_ROW",
    message: `${table} row ${key} is not valid state`,
    retry: "never",
  });

// The server's own receipts: what Project#replay reads back. The state owner checks its own tables.
function checkServerReceipt(row: Row): void {
  const key = String(row.request_id);
  const bad = (): never => {
    throw rejectedRow("domain_cloud_requests", key);
  };
  let fingerprint: unknown;
  let result: unknown;
  try {
    fingerprint = JSON.parse(String(row.fingerprint));
    result = JSON.parse(String(row.result));
  } catch {
    return bad();
  }
  const input = fingerprint as { route?: unknown; subject?: unknown } | null;
  if (
    !REQUEST_ID.test(key) ||
    input === null ||
    typeof input !== "object" ||
    !["claim", "renew", "release"].includes(String(input.route)) ||
    typeof input.subject !== "string"
  )
    bad();
  if (row.outcome === "ok") {
    const lease = validateLeaseRecord(result);
    if (!lease.ok || lease.value.subject !== input!.subject) bad();
  } else {
    const failure = validateForgeError(result);
    if (
      !failure.ok ||
      !String(row.outcome).startsWith("LEASE_") ||
      failure.value.code !== row.outcome
    )
      bad();
  }
}

function insertRows(db: SqlDatabase, tables: Record<string, Row[]>): void {
  for (const [table, { columns }] of Object.entries(TABLES))
    for (const row of tables[table]!)
      try {
        db.run(
          `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
          columns.map((column) => row[column]!),
        );
      } catch {
        throw invalid(`A ${table} row conflicts with another row`);
      }
}

// The row checks of a restore, over every row now in the project (a whole dump, or all staged pages):
// the server's receipts, then the state owner's own check of an imported image. Every body parses with
// the runtime parsers, agrees with its indexed columns and replays from the events.
function verifyRestored(db: SqlDatabase): void {
  const receipts = Object.keys(TABLES).indexOf("domain_cloud_requests");
  for (const { row } of rowsFrom(db, receipts, null)) checkServerReceipt(row);
  try {
    verifyEventDerivedState(
      db,
      Number(db.get("SELECT COUNT(*) AS n FROM state_events")!.n),
    );
  } catch (error) {
    if (error instanceof RestoreConsistencyFailure)
      throw rejectedRow(error.table, error.key);
    throw error;
  }
}

/** Writes a dump into an empty project and reads it back in the same transaction; any difference rolls it back. */
export function restoreDump(
  db: SqlDatabase,
  dump: Dump,
): Record<string, number> {
  return db.transaction(() => {
    const before = dumpOf(db);
    if (Object.values(before.tables).some((rows) => rows.length > 0))
      throw new ForgeFailure({
        code: "RESTORE_TARGET_NOT_EMPTY",
        message: "A dump restores only into an empty project",
        retry: "never",
      });
    insertRows(db, dump.tables);
    verifyRestored(db);
    if (JSON.stringify(dumpOf(db)) !== JSON.stringify(dump))
      throw invalid(
        "The dump rows must be in dump order and read back identical",
      );
    return counts(dump.tables);
  });
}

/** Removes every staged row. Only an unprovisioned project has staged rows, and it serves nothing. */
export function clearStaged(db: SqlDatabase): void {
  db.transaction(() => {
    for (const table of Object.keys(TABLES)) db.run(`DELETE FROM ${table}`);
  });
}

/**
 * Stages one page of a paged restore. Page 0 clears what an earlier try staged. The last page runs the
 * row checks over everything staged, so a refusal there rolls that page back; the caller then clears
 * the rest. The size is checked in SQL before the new rows are written and before the checks load them.
 */
export function restorePage(
  db: SqlDatabase,
  page: Page,
  limits: Limits,
): Record<string, number> {
  const guard = (): void =>
    assertSize(db, limits.maxBytes, "RESTORE_TOO_LARGE", "The staged restore");
  return db.transaction(() => {
    if (page.page === 0) clearStaged(db);
    else guard();
    insertRows(db, page.tables);
    if (page.last) {
      guard();
      verifyRestored(db);
    }
    return counts(page.tables);
  });
}
