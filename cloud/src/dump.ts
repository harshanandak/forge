// A project as plain JSON: its issues (state_records), leases, events and receipts, and nothing else.
// Device tokens and their hashes are never part of a dump. The database image is never used.
// Every value is a string or a safe integer; anything else is refused on the way out and on the way in.
import { ForgeFailure } from "../../src/contract/failure.ts";
import { isObject } from "../../src/core/config/pointer.ts";
import {
  RestoreConsistencyFailure,
  verifyEventDerivedState,
  type NumberedSummary,
  type StateOwner,
} from "../../src/core/state/index.ts";
import {
  parseRestoreJson,
  withinRestoreBudget,
} from "../../src/core/state/restore-json.ts";
import {
  validateForgeError,
  validateLeaseRecord,
} from "../../src/generated/validators.ts";
import type { SqlDatabase, SqlRow } from "../../src/ports/store.ts";
import { versioned } from "./issue-request-id.ts";

export const DUMP_FORMAT = "forge-cloud-dump/2";
export const COMMAND_RECEIPTS = "domain_cloud_command_receipts";
export const EXPORT_STATE = "domain_cloud_export";

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
  [COMMAND_RECEIPTS]: {
    columns: [
      "request_id",
      "fingerprint",
      "outcome",
      "result",
      "created_at",
      "expires_at",
    ],
    keys: ["request_id"],
  },
};

export const PAGE_FORMAT = "forge-cloud-dump-page/2";

// Triggers cover every mutation, including receipt-only refusals and deletes, in its transaction.
// Export metadata is server-local: restoring rows never imports another project's epoch.
export const DUMP_MIGRATION = {
  id: "005_cloud_command_receipts",
  statements: [
    `CREATE TABLE ${COMMAND_RECEIPTS} (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, outcome TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
    `CREATE INDEX command_receipts_expiry ON ${COMMAND_RECEIPTS} (expires_at, request_id)`,
    `CREATE TABLE ${EXPORT_STATE} (id INTEGER PRIMARY KEY CHECK(id=1), epoch TEXT NOT NULL, revision INTEGER NOT NULL)`,
    `INSERT INTO ${EXPORT_STATE} VALUES (1, lower(hex(randomblob(16))), 0)`,
    ...Object.keys(TABLES).flatMap((table) =>
      ["INSERT", "UPDATE", "DELETE"].map(
        (action) =>
          `CREATE TRIGGER export_${table}_${action.toLowerCase()} AFTER ${action} ON ${table} BEGIN UPDATE ${EXPORT_STATE} SET revision=revision+1 WHERE id=1; END`,
      ),
    ),
  ],
};

// Server-local provenance preserves audit bytes without trusting an imported expiry for admission.
export const IMPORT_MIGRATION = {
  id: "006_cloud_imported_receipts",
  statements: [
    `ALTER TABLE ${COMMAND_RECEIPTS} ADD COLUMN imported INTEGER NOT NULL DEFAULT 0 CHECK(imported IN (0, 1))`,
    // The shipped 005 schema writes this table only through restore; typed writes still use legacy records.
    `UPDATE ${COMMAND_RECEIPTS} SET imported=1`,
    `CREATE INDEX command_receipts_live ON ${COMMAND_RECEIPTS} (imported, expires_at)`,
  ],
};

// Limits on a dump, on the way out and on the way in. The depth is exactly what the format needs:
// document, tables, rows array, row. The caps keep a hostile or broken document from filling the isolate.
const MAX_DEPTH = 4;
const MAX_ROWS_PER_TABLE = 10_000;
// The project limits a deploy gets when DUMP_MAX_ROWS and DUMP_MAX_BYTES are not set (measured in forge-1040).
// The whole format keeps MAX_ROWS_PER_TABLE and its own byte ceiling below; only the paged format reaches these.
const DEFAULT_MAX_ROWS = 20_000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const MAX_VALUE_LENGTH = 262_144;
// The columns that hold open JSON (a stored record, an event, a replay request) have no schema maximum: a
// 65,536 character body whose characters each escape to six is about 393,000 stored, and a record, its
// event and its receipt each carry it. Their ceiling is the transport one, the 8 MiB restore body, which
// no UTF-8 text can exceed in characters. Every other string keeps the compatibility ceiling.
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const WIDE_COLUMNS = [
  "state_records.body",
  "state_events.body",
  "state_requests.fingerprint",
  "state_requests.result",
  `${COMMAND_RECEIPTS}.result`,
];
const valueLimit = (table: string, column: string): number =>
  WIDE_COLUMNS.includes(`${table}.${column}`)
    ? MAX_TEXT_BYTES
    : MAX_VALUE_LENGTH;
// A cursor is two key parts of up to MAX_VALUE_LENGTH characters, each escaped to at most six, in a
// 47 character skeleton with two 19 digit watermark numbers and their dot.
const MAX_CURSOR_LENGTH = 47 + 2 * 6 * MAX_VALUE_LENGTH + 52;
const WATERMARK = /^(?:[a-f0-9]{32}\.\d{1,19})?$/;
const encoder = new TextEncoder();
const byteLength = (value: unknown): number =>
  encoder.encode(JSON.stringify(value)).length;
// A whole (unpaged) dump holds at most this much stored. Escaping can grow it up to six times, so dumpOf
// also measures the serialized size against the restore body.
const WHOLE_DUMP_BYTES = 3 * 1024 * 1024;
// Rows are read this many at a time, so a page never holds more than a page plus one batch.
const BATCH = 16;

/** Page and project size in bytes, and rows per table. A deploy uses the defaults; the test config lowers them. */
export interface Limits {
  readonly pageBytes: number;
  readonly maxBytes: number;
  readonly maxRows: number;
}
export function limitsFrom(env: unknown): Limits {
  const vars = (env ?? {}) as Record<string, unknown>;
  const read = (name: string, fallback: number): number => {
    const value = Number(vars[name]);
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
  };
  return {
    pageBytes: read("DUMP_PAGE_BYTES", 4 * 1024 * 1024),
    maxBytes: read("DUMP_MAX_BYTES", DEFAULT_MAX_BYTES),
    maxRows: read("DUMP_MAX_ROWS", DEFAULT_MAX_ROWS),
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
  p: number; // page number
  t: number; // table index
  k: Key | null; // last key written in that table
  w: string; // the project's write watermark when page 0 was cut
}

const invalid = (message: string): ForgeFailure =>
  new ForgeFailure({ code: "INPUT_INVALID", message, retry: "never" });
const emptyTables = (): Record<string, Row[]> =>
  Object.fromEntries(Object.keys(TABLES).map((table) => [table, []]));
const counts = (tables: Record<string, Row[]>): Record<string, number> =>
  Object.fromEntries(
    Object.entries(tables).map(([table, rows]) => [table, rows.length]),
  );

// The row count and stored size of the five tables, counted and summed by SQLite, so a check loads no
// row. Validation holds a whole project in memory, so both are bounded before it runs.
function assertLimits(
  db: SqlDatabase,
  limits: Limits,
  code: string,
  what: string,
  maxBytes = limits.maxBytes,
  hint = "",
): void {
  let bytes = 0;
  for (const [table, { columns }] of Object.entries(TABLES)) {
    const found = db.get(
      `SELECT COUNT(*) AS n, COALESCE(SUM(${columns.map((column) => `LENGTH(CAST(${column} AS BLOB))`).join(" + ")}), 0) AS bytes FROM ${table}`,
    )!;
    if (Number(found.n) > limits.maxRows)
      throw new ForgeFailure({
        code,
        message: `${table} has ${Number(found.n)} rows, over the ${limits.maxRows} row limit.`,
        retry: "never",
      });
    bytes += Number(found.bytes);
  }
  if (bytes > maxBytes)
    throw new ForgeFailure({
      code,
      message: `${what} holds ${bytes} bytes, over the ${maxBytes} byte limit.${hint}`,
      retry: "never",
    });
}

function rowOf(table: string, row: SqlRow): Row {
  return Object.fromEntries(
    TABLES[table]!.columns.map((column) => {
      const value = row[column];
      if (
        (typeof value === "string" &&
          value.length <= valueLimit(table, column)) ||
        (typeof value === "number" && Number.isSafeInteger(value))
      )
        return [column, value];
      throw new ForgeFailure({
        code: "DUMP_UNSAFE_VALUE",
        message: `${table}.${column} holds a value that is not a string (up to ${valueLimit(table, column)} characters) or a safe integer`,
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
    assertLimits(
      db,
      limits,
      "DUMP_TOO_LARGE",
      "The project",
      Math.min(limits.maxBytes, WHOLE_DUMP_BYTES),
      " Dump it in pages with GET dump?cursor=start.",
    );
  const tables = emptyTables();
  const names = Object.keys(TABLES);
  // The dump is measured as it will be sent: escaping turns one stored byte into up to six, so a project
  // within the stored limit can still be too large for the restore body, and could never be restored.
  let sent =
    limits === undefined ? 0 : byteLength({ format: DUMP_FORMAT, tables });
  for (const { table, row } of rowsFrom(db, 0, null)) {
    const rows = tables[names[table]!]!;
    if (rows.length >= MAX_ROWS_PER_TABLE)
      throw new ForgeFailure({
        code: "DUMP_TOO_LARGE",
        message: `${names[table]} has more than ${MAX_ROWS_PER_TABLE} rows`,
        retry: "never",
      });
    if (limits !== undefined)
      sent += byteLength(row) + (rows.length > 0 ? 1 : 0);
    if (sent > MAX_TEXT_BYTES)
      throw new ForgeFailure({
        code: "DUMP_TOO_LARGE",
        message: `The dump is over the ${MAX_TEXT_BYTES} byte restore body once escaped. Dump it in pages with GET dump?cursor=start.`,
        retry: "never",
      });
    rows.push(row);
  }
  return { format: DUMP_FORMAT, tables };
}

function parseCursor(text: string): Cursor {
  if (text === "start") return { p: 0, t: 0, k: null, w: "" };
  const bad = (): ForgeFailure =>
    invalid("The cursor must be start or a cursor a page returned");
  if (text.length > MAX_CURSOR_LENGTH) throw bad();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw bad();
  }
  const cursor = value as Record<string, unknown> | null;
  if (
    cursor === null ||
    typeof cursor !== "object" ||
    Object.keys(cursor).sort().join() !== "k,p,t,w" ||
    !Number.isSafeInteger(cursor.p) ||
    (cursor.p as number) < 0 ||
    typeof cursor.w !== "string" ||
    !WATERMARK.test(cursor.w) ||
    !Number.isSafeInteger(cursor.t) ||
    (cursor.t as number) < 0
  )
    throw bad();
  const table = Object.values(TABLES)[cursor.t as number];
  // Page 0 is always the start of the first table. Every other key has its table's types.
  if (
    table === undefined ||
    (cursor.p === 0 && (cursor.t !== 0 || cursor.k !== null)) ||
    (cursor.k !== null &&
      (!Array.isArray(cursor.k) ||
        cursor.k.length !== table.keys.length ||
        cursor.k.some((part: unknown, index) =>
          table.keys[index] === "sequence"
            ? !Number.isSafeInteger(part)
            : typeof part !== "string" || part.length > MAX_VALUE_LENGTH,
        )))
  )
    throw bad();
  return cursor as unknown as Cursor;
}

// An epoch distinguishes restores; the transactional counter also detects deletions and updates.
function watermark(db: SqlDatabase): string {
  const row = db.get(`SELECT epoch, revision FROM ${EXPORT_STATE} WHERE id=1`)!;
  return `${String(row.epoch)}.${String(row.revision).padStart(19, "0")}`;
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

/**
 * One page of a project. The whole page document, counted in UTF-8 with its arrays, commas, metadata and
 * cursor, is within `limits.pageBytes` and the 8 MiB restore body. A row is never split, so a row that
 * cannot fit alone with its envelope is refused as DUMP_TOO_LARGE rather than returned.
 */
export function dumpPage(
  db: SqlDatabase | undefined,
  cursorText: string,
  limits: Limits,
): Page {
  const from = parseCursor(cursorText);
  const tables = emptyTables();
  const budget = Math.min(limits.pageBytes, MAX_TEXT_BYTES);
  const tooLarge = (what: string): ForgeFailure =>
    new ForgeFailure({
      code: "DUMP_TOO_LARGE",
      message: `${what} is over the ${budget} byte page limit.`,
      retry: "never",
    });
  // A page with no rows is still a page: its envelope alone must be within the budget.
  const empty = (): Page => {
    const page = pageOf(from.p, tables, null);
    if (byteLength(page) > budget) throw tooLarge("A page envelope");
    return page;
  };
  if (db === undefined) return empty();
  // A page is cut in one synchronous call, so a write cannot land inside it. A write between pages
  // would give a dump with a lease body and no event for it, which cannot be restored.
  const now = watermark(db);
  // Every page request is checked, not only the first: a forged continuation cursor must not reach rows
  // that cursor=start refuses.
  assertLimits(db, limits, "DUMP_TOO_LARGE", "The project");
  if (from.p !== 0 && from.w !== now)
    throw new ForgeFailure({
      code: "DUMP_CHANGED",
      message:
        "The project changed during the export; start again from cursor=start",
      retry: "never",
    });
  const names = Object.keys(TABLES);
  const bare = emptyTables();
  let used = 0; // bytes of the rows and the commas between them
  let next: Cursor = { p: from.p + 1, t: from.t, k: from.k, w: now };
  const rows = rowsFrom(db, from.t, from.k);
  for (let step = rows.next(); !step.done;) {
    const { table, row } = step.value;
    const after = rows.next();
    const list = tables[names[table]!]!;
    const here: Cursor = {
      p: from.p + 1,
      t: table,
      k: TABLES[names[table]!]!.keys.map((column) => row[column]!),
      w: now,
    };
    // The page as it would be cut after this row. The last page has no cursor, so it is the smaller form.
    const added = byteLength(row) + (list.length > 0 ? 1 : 0);
    if (
      byteLength(pageOf(from.p, bare, after.done ? null : here)) +
        used +
        added >
      budget
    ) {
      if (used === 0) throw tooLarge("A row with its page envelope");
      return pageOf(from.p, tables, next);
    }
    list.push(row);
    used += added;
    next = here;
    step = after;
  }
  return used === 0 ? empty() : pageOf(from.p, tables, null);
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
  // Bounded by bytes before anything is built: UTF-8 is at most three bytes per UTF-16 unit.
  if (
    text.length > MAX_TEXT_BYTES ||
    (text.length * 3 > MAX_TEXT_BYTES &&
      encoder.encode(text).length > MAX_TEXT_BYTES)
  )
    throw invalid(`The dump is over ${MAX_TEXT_BYTES} bytes`);
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
  const old =
    document.format === "forge-cloud-dump/1" ||
    document.format === "forge-cloud-dump-page/1";
  const paged =
    document.format === PAGE_FORMAT ||
    document.format === "forge-cloud-dump-page/1";
  if (
    Object.keys(document).sort().join() !==
    (paged ? "format,last,next,page,tables" : "format,tables")
  )
    throw invalid(
      paged
        ? "A dump page must have exactly format, page, last, next and tables"
        : "The dump must have exactly format and tables",
    );
  if (!paged && document.format !== DUMP_FORMAT && !old)
    throw invalid(`The dump format must be ${DUMP_FORMAT}`);
  if (
    paged &&
    (!Number.isSafeInteger(document.page) ||
      (document.page as number) < 0 ||
      document.last !== (document.next === null) ||
      (document.next !== null &&
        (typeof document.next !== "string" ||
          document.next.length > MAX_CURSOR_LENGTH)))
  )
    throw invalid(
      "A dump page needs a page number and next (null on the last)",
    );
  const given = document.tables as Record<string, unknown> | null;
  if (given === null || typeof given !== "object" || Array.isArray(given))
    throw invalid("The dump needs a tables object");
  const names = Object.keys(TABLES).filter(
    (table) => !old || table !== COMMAND_RECEIPTS,
  );
  if (Object.keys(given).sort().join() !== [...names].sort().join())
    throw invalid(`The dump tables must be exactly ${names.join(", ")}`);
  const tables: Record<string, Row[]> = {};
  for (const [table, { columns }] of Object.entries(TABLES)) {
    if (old && table === COMMAND_RECEIPTS) {
      tables[table] = [];
      continue;
    }
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
            (typeof value === "string" &&
              value.length <= valueLimit(table, column)) ||
            (typeof value === "number" && Number.isSafeInteger(value))
          )
            return [column, value];
          throw invalid(
            `${table}.${column} must be a string (up to ${valueLimit(table, column)} characters) or a safe integer (53 bits)`,
          );
        }),
      );
    });
  }
  return paged
    ? {
        format: document.format as string,
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
    fingerprint = parseRestoreJson(String(row.fingerprint));
    result = parseRestoreJson(String(row.result));
  } catch {
    return bad();
  }
  const input = fingerprint as { route?: unknown; subject?: unknown } | null;
  if (
    !REQUEST_ID.test(key) ||
    input === null ||
    typeof input !== "object" ||
    !["claim", "renew", "release"].includes(String(input.route)) ||
    typeof input.subject !== "string" ||
    ("scope" in input && !versioned(input))
  )
    bad();
  if (row.outcome === "ok") {
    const lease = validateLeaseRecord(result);
    if (!lease.ok || lease.value.subject !== input!.subject) bad();
  } else {
    const failure = validateForgeError(result);
    if (
      !failure.ok ||
      (!String(row.outcome).startsWith("LEASE_") &&
        row.outcome !== "INPUT_INVALID") ||
      failure.value.code !== row.outcome
    )
      bad();
  }
}

// Every column that holds JSON the restore will parse, in dump order.
const JSON_COLUMNS: Record<string, string[]> = {
  state_records: ["body"],
  state_events: ["body"],
  state_leases: ["body"],
  state_requests: ["fingerprint", "result"],
  domain_cloud_requests: ["fingerprint", "result"],
  [COMMAND_RECEIPTS]: ["fingerprint", "result"],
};

/**
 * Refuses the first body, fingerprint or result past the raw-text JSON budget (32 levels, 5,000 values), naming its
 * table and key, before any of it is parsed: the verifier's JSON.parse would build a tree as large as the text asks.
 */
function admitJson(tables: Record<string, Row[]>): void {
  for (const [table, columns] of Object.entries(JSON_COLUMNS))
    for (const row of tables[table]!)
      for (const column of columns)
        if (!withinRestoreBudget(String(row[column])))
          throw rejectedRow(
            table,
            table === "domain_cloud_requests" || table === COMMAND_RECEIPTS
              ? String(row.request_id)
              : JSON.stringify([
                  row.namespace,
                  row.key ?? row.subject ?? row.request_id,
                ]),
          );
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

// The allocator's floor: the work block numbers issues as `issue:work-<n>` in forge/work, and a floor record
// holds the highest number ever given. Comments and links are numbered per issue the same way, so each
// observed `comment:<id>:` and `link:<id>:` has its own floor. Only this file names them; the state owner
// takes the issue prefix and the family of the others as arguments.
const FAMILY = (key: string) =>
  /^((?:comment|link):[^:]+:)[1-9][0-9]*$/.exec(key)?.[1];
const NUMBERED = {
  namespace: "forge/work",
  prefix: "issue:work-",
  family: FAMILY,
};
const SEEDER = { kind: "agent", id: "cloud-restore" } as const;

// The row checks of a restore, over every row now in the project (a whole dump, or all staged pages):
// the server's receipts, then the state owner's own check of an imported image. Every body parses with
// the runtime parsers, agrees with its indexed columns and replays from the events. The same replay
// reports the highest issue number its history holds.
function verifyRestored(db: SqlDatabase): {
  found: NumberedSummary;
  events: number;
} {
  const receipts = Object.keys(TABLES).indexOf("domain_cloud_requests");
  for (const { table, row } of rowsFrom(db, receipts, null))
    if (table === receipts) checkServerReceipt(row);
    else checkCommandReceipt(row);
  const events = Number(db.get("SELECT COUNT(*) AS n FROM state_events")!.n);
  try {
    const found = verifyEventDerivedState(db, events, undefined, NUMBERED);
    return { found: found!, events };
  } catch (error) {
    if (error instanceof RestoreConsistencyFailure)
      throw rejectedRow(error.table, error.key);
    throw error;
  }
}

// The last step of a restore, in its transaction: a supplied floor is checked and kept as it is, and a
// missing one is written (0 when nothing was ever numbered for issues), the issue floor first and then
// each observed comment and link floor in prefix order. Each written pair is one more event, so the next
// seed is told the count including it. Then the project is measured again, so the written pairs have the
// same budgets as the rows that came in.
function settleFloor(
  db: SqlDatabase,
  owner: StateOwner,
  limits: Limits,
  restored: { found: NumberedSummary; events: number },
): void {
  try {
    let events = restored.events;
    for (const [prefix, found] of [
      [NUMBERED.prefix, restored.found] as const,
      ...(restored.found.groups ?? []),
    ])
      if (
        owner.seedNumberFloor(NUMBERED.namespace, prefix, found, SEEDER, events)
      )
        events++;
  } catch (error) {
    if (error instanceof RestoreConsistencyFailure)
      throw rejectedRow(error.table, error.key);
    throw error;
  }
  assertLimits(db, limits, "RESTORE_TOO_LARGE", "The restored project");
  db.run(`UPDATE ${COMMAND_RECEIPTS} SET imported=1`);
  freshEpoch(db);
}

/** Writes a dump into an empty project and reads it back in the same transaction; any difference rolls it back. */
export function restoreDump(
  db: SqlDatabase,
  owner: StateOwner,
  dump: Dump,
  limits: Limits,
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
    assertLimits(db, limits, "RESTORE_TOO_LARGE", "The restored project");
    admitJson(dump.tables);
    const restored = verifyRestored(db);
    if (JSON.stringify(dumpOf(db)) !== JSON.stringify(dump))
      throw invalid(
        "The dump rows must be in dump order and read back identical",
      );
    settleFloor(db, owner, limits, restored);
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
 * Stages one page of a paged restore. Page 0 clears what an earlier try staged. The limits are checked
 * after every page is written, in the same transaction, so the page that crosses one is the page that
 * is refused. The last page then runs the row checks over everything staged and settles the issue number
 * floor; a refusal rolls that page back, and the caller clears the rest.
 */
export function restorePage(
  db: SqlDatabase,
  owner: StateOwner,
  page: Page,
  limits: Limits,
): Record<string, number> {
  return db.transaction(() => {
    if (page.page === 0) clearStaged(db);
    insertRows(db, page.tables);
    assertLimits(db, limits, "RESTORE_TOO_LARGE", "The staged restore");
    admitJson(page.tables);
    // Only the last page looks at the whole staged set, so nothing is derived or written before it.
    if (page.last) settleFloor(db, owner, limits, verifyRestored(db));
    return counts(page.tables);
  });
}

function freshEpoch(db: SqlDatabase): void {
  db.run(
    `UPDATE ${EXPORT_STATE} SET epoch=lower(hex(randomblob(16))), revision=0 WHERE id=1`,
  );
}

function checkCommandReceipt(row: Row): void {
  const bad = (): never => {
    throw rejectedRow(COMMAND_RECEIPTS, String(row.request_id));
  };
  let fingerprint: unknown, result: unknown;
  try {
    fingerprint = parseRestoreJson(String(row.fingerprint));
    result = parseRestoreJson(String(row.result));
  } catch {
    return bad();
  }
  if (
    !/^c2:[a-f0-9]{64}$/.test(String(row.request_id)) ||
    !isObject(fingerprint) ||
    !versioned(fingerprint) ||
    typeof fingerprint.input !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(fingerprint.input) ||
    typeof row.created_at !== "number" ||
    typeof row.expires_at !== "number" ||
    row.created_at < 0 ||
    row.expires_at <= row.created_at ||
    !["ok", "refused"].includes(String(row.outcome)) ||
    (row.outcome === "refused" && !validateForgeError(result).ok)
  )
    bad();
}
