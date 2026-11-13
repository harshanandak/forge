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

/** Every namespace that holds a row in any state table, sorted. Reads only. */
export function namespacesOf(db: SqlDatabase): string[] {
  const union = Object.keys(STATE_TABLES)
    .map((table) => `SELECT namespace FROM ${table}`)
    .join(" UNION ");
  return db
    .all(`${union} ORDER BY namespace`)
    .map((row) => String(row.namespace));
}

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
