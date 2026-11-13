import type { SqlDatabase, SqlRow } from "../../ports/store.ts";

/** The state tables a read-only export can select from: each one's columns and the single key that orders it within a namespace. */
export const STATE_TABLES = {
  state_records: {
    columns: ["namespace", "key", "revision", "body"],
    key: "key",
  },
  state_events: {
    columns: ["sequence", "namespace", "key", "body"],
    key: "sequence",
  },
  state_leases: {
    columns: ["namespace", "subject", "generation", "body"],
    key: "subject",
  },
  state_requests: {
    columns: ["namespace", "request_id", "fingerprint", "result"],
    key: "request_id",
  },
} as const;
export type StateTable = keyof typeof STATE_TABLES;

/**
 * Every row of one namespace in one table, in key order, read `batch` rows at a time by keyset so a caller
 * that stops early never loads the rest. It opens, migrates, repairs and writes nothing.
 */
export function* readRows(
  db: SqlDatabase,
  table: StateTable,
  namespace: string,
  batch = 500,
): Generator<SqlRow> {
  // A batch that is not a positive safe integer would never advance.
  if (!Number.isSafeInteger(batch) || batch < 1)
    throw new RangeError("batch must be a positive safe integer");
  const { columns, key } = STATE_TABLES[table];
  let after: SqlRow[string] | undefined;
  for (;;) {
    const found = db.all(
      `SELECT ${columns.join(", ")} FROM ${table} WHERE namespace = ?${after === undefined ? "" : ` AND ${key} > ?`} ORDER BY ${key} LIMIT ?`,
      after === undefined ? [namespace, batch] : [namespace, after, batch],
    );
    for (const row of found) {
      yield row;
      after = row[key];
    }
    if (found.length < batch) return;
  }
}
