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
import type { SqlDatabase } from "../../src/ports/store.ts";

export const DUMP_FORMAT = "forge-cloud-dump/1";

const TABLES: Record<string, { columns: string[]; order: string }> = {
  state_records: {
    columns: ["namespace", "key", "revision", "body"],
    order: "namespace, key",
  },
  state_events: {
    columns: ["sequence", "namespace", "key", "body"],
    order: "sequence",
  },
  state_leases: {
    columns: ["namespace", "subject", "generation", "body"],
    order: "namespace, subject",
  },
  state_requests: {
    columns: ["namespace", "request_id", "fingerprint", "result"],
    order: "namespace, request_id",
  },
  domain_cloud_requests: {
    columns: ["request_id", "fingerprint", "outcome", "result"],
    order: "request_id",
  },
};

// Limits on a dump, on the way out and on the way in. The depth is exactly what the format needs:
// document, tables, rows array, row. The caps keep a hostile or broken document from filling the isolate.
const MAX_DEPTH = 4;
const MAX_ROWS_PER_TABLE = 50_000;
const MAX_VALUE_LENGTH = 262_144;

type Row = Record<string, string | number>;
export interface Dump {
  format: string;
  tables: Record<string, Row[]>;
}

const invalid = (message: string): ForgeFailure =>
  new ForgeFailure({ code: "INPUT_INVALID", message, retry: "never" });
const emptyTables = (): Record<string, Row[]> =>
  Object.fromEntries(Object.keys(TABLES).map((table) => [table, []]));

/** The dump of a project; undefined means the project was never provisioned, so it has no database. */
export function dumpOf(db: SqlDatabase | undefined): Dump {
  if (db === undefined) return { format: DUMP_FORMAT, tables: emptyTables() };
  const tables = emptyTables();
  for (const [table, { columns, order }] of Object.entries(TABLES)) {
    const found = db.all(
      `SELECT ${columns.join(", ")} FROM ${table} ORDER BY ${order} LIMIT ${MAX_ROWS_PER_TABLE + 1}`,
    );
    if (found.length > MAX_ROWS_PER_TABLE)
      throw new ForgeFailure({
        code: "DUMP_TOO_LARGE",
        message: `${table} has more than ${MAX_ROWS_PER_TABLE} rows`,
        retry: "never",
      });
    tables[table] = found.map((row) =>
      Object.fromEntries(
        columns.map((column) => {
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
      ),
    );
  }
  return { format: DUMP_FORMAT, tables };
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

/** Checks a dump document strictly and returns it with every row in column order. */
export function parseDump(text: string): Dump {
  checkDepth(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid("The dump must be JSON");
  }
  const document = parsed as { format?: unknown; tables?: unknown } | null;
  if (document === null || typeof document !== "object")
    throw invalid("The dump must be a JSON object");
  if (Object.keys(document).sort().join() !== "format,tables")
    throw invalid("The dump must have exactly format and tables");
  if (document.format !== DUMP_FORMAT)
    throw invalid(`The dump format must be ${DUMP_FORMAT}`);
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
    if (rows.length > MAX_ROWS_PER_TABLE)
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
  return { format: DUMP_FORMAT, tables };
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

/** Writes a dump into an empty project and reads it back in the same transaction; any difference rolls it back. */
export function restoreDump(
  db: SqlDatabase,
  dump: Dump,
): Record<string, number> {
  for (const row of dump.tables.domain_cloud_requests!) checkServerReceipt(row);
  return db.transaction(() => {
    const before = dumpOf(db);
    if (Object.values(before.tables).some((rows) => rows.length > 0))
      throw new ForgeFailure({
        code: "RESTORE_TARGET_NOT_EMPTY",
        message: "A dump restores only into an empty project",
        retry: "never",
      });
    for (const [table, { columns }] of Object.entries(TABLES))
      for (const row of dump.tables[table]!)
        try {
          db.run(
            `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
            columns.map((column) => row[column]!),
          );
        } catch {
          throw invalid(`A ${table} row conflicts with another row`);
        }
    // The runtime's own check of an imported image: every body parses with the runtime parsers, agrees
    // with its indexed columns, and replays from the events. A refusal rolls the whole restore back.
    try {
      verifyEventDerivedState(db, dump.tables.state_events!.length);
    } catch (error) {
      if (error instanceof RestoreConsistencyFailure)
        throw rejectedRow(error.table, error.key);
      throw error;
    }
    if (JSON.stringify(dumpOf(db)) !== JSON.stringify(dump))
      throw invalid(
        "The dump rows must be in dump order and read back identical",
      );
    return Object.fromEntries(
      Object.entries(dump.tables).map(([table, rows]) => [table, rows.length]),
    );
  });
}
