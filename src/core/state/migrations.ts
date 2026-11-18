import type { SqlDatabase } from "../../ports/store.ts";
import { checkpointTables } from "./checkpoint.ts";
import { ForgeFailure } from "../../contract/failure.ts";

export interface Migration {
  readonly id: string;
  readonly statements: readonly string[];
}

/** Fresh 0.1.0 schema. Later ADD COLUMN fields belong only to their migration. */
export const baseline: Migration = {
  id: "001_state_010",
  statements: [
    "CREATE TABLE IF NOT EXISTS state_records (namespace TEXT NOT NULL, key TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0), body TEXT NOT NULL, PRIMARY KEY(namespace,key))",
    "CREATE TABLE IF NOT EXISTS state_events (sequence INTEGER PRIMARY KEY, namespace TEXT NOT NULL, key TEXT NOT NULL, body TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS state_leases (namespace TEXT NOT NULL, subject TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation > 0), body TEXT NOT NULL, PRIMARY KEY(namespace,subject))",
    "CREATE TABLE IF NOT EXISTS state_requests (namespace TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(namespace,request_id))",
    "CREATE TABLE IF NOT EXISTS state_domains (namespace TEXT NOT NULL, table_name TEXT NOT NULL PRIMARY KEY, reviewed_digest TEXT NOT NULL)",
  ],
};

/** Reading one key's history must not scan the whole event log. */
export const eventKeyIndex: Migration = {
  id: "002_state_events_key_index",
  statements: [
    "CREATE INDEX IF NOT EXISTS state_events_by_key ON state_events (namespace, key, sequence)",
  ],
};

/** Older binaries must refuse stores whose lease authority uses device and session. */
export const deviceSessionIdentity: Migration = {
  id: "003_device_session_identity",
  statements: ["SELECT 1"],
};

export const retentionTables: readonly string[] = [
  "state_retention",
  "state_namespace_watermarks",
  "state_usage",
  "state_allocation_keys",
];
export const stateColumns: Record<string, readonly string[]> = {
  state_records: ["namespace", "key", "revision", "body"],
  state_events: ["sequence", "namespace", "key", "body"],
  state_leases: ["namespace", "subject", "generation", "body"],
  state_requests: ["namespace", "request_id", "fingerprint", "result"],
};
const bytes = (columns: readonly string[], prefix = "") =>
  columns
    .map((column) => `LENGTH(CAST(${prefix}${column} AS BLOB))`)
    .join(" + ");

/** Column bytes, including integer text, match cloud dump accounting exactly. */
export function usageStatements(
  tables: Record<string, readonly string[]>,
): string[] {
  return Object.entries(tables).flatMap(([table, columns]) => [
    `INSERT INTO state_usage SELECT '${table}', COUNT(*), COALESCE(SUM(${bytes(columns)}),0) FROM ${table}`,
    ...["INSERT", "UPDATE", "DELETE"].map((action) => {
      const delta = action === "INSERT" ? 1 : action === "DELETE" ? -1 : 0;
      const size = [
        action !== "DELETE" ? `(${bytes(columns, "NEW.")})` : "0",
        action !== "INSERT" ? `(${bytes(columns, "OLD.")})` : "0",
      ].join(" - ");
      return `CREATE TRIGGER usage_${table}_${action.toLowerCase()} AFTER ${action} ON ${table} BEGIN UPDATE state_usage SET rows=rows+(${delta}), bytes=bytes+(${size}) WHERE table_name='${table}'; END`;
    }),
  ]);
}

// Unknown historical ages start at upgrade time, never guessed old enough to expire.
export function requestAgeStatements(table: string): string[] {
  const now = "CAST(strftime('%s','now') AS INTEGER)*1000";
  return [
    `ALTER TABLE ${table} ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0 CHECK(created_at>=0)`,
    `UPDATE ${table} SET created_at=${now}`,
    `CREATE TRIGGER age_${table} AFTER INSERT ON ${table} WHEN NEW.created_at=0 BEGIN UPDATE ${table} SET created_at=${now} WHERE rowid=NEW.rowid; END`,
  ];
}

function refuse(
  message = "State retention metadata mismatch; restore a verified backup or repair the store before retrying",
): never {
  throw new ForgeFailure({ code: "INPUT_INVALID", message, retry: "never" });
}

/** Retained authority is data; coverage is required, but extra reservations survive pruning. */
export function assertRetentionAuthority(db: SqlDatabase, empty = false): void {
  if (
    !db.get(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='state_retention'",
    )
  )
    return;
  if (
    empty &&
    db.get(
      "SELECT 1 FROM state_retention WHERE sequence<>0 UNION ALL SELECT 1 FROM state_namespace_watermarks UNION ALL SELECT 1 FROM state_allocation_keys LIMIT 1",
    )
  )
    refuse("Restore target must be empty");
  if (
    db.get(
      "SELECT 1 FROM (SELECT namespace,key FROM state_records UNION ALL SELECT namespace,key FROM state_events WHERE CASE WHEN json_valid(body) THEN json_extract(body,'$.type') IN (namespace||':record.updated@1',namespace||':record.deleted@1') ELSE 0 END) needed WHERE NOT EXISTS (SELECT 1 FROM state_allocation_keys r WHERE r.namespace=needed.namespace AND r.key=needed.key) LIMIT 1",
    )
  )
    refuse();
}

/** Validate on admitted setup, never repair a persisted disagreement implicitly. */
export function assertRetention(
  db: SqlDatabase,
  tables: Record<string, readonly string[]> = stateColumns,
  stagedRestore = false,
): void {
  if (!stagedRestore) assertRetentionAuthority(db);
  const row = db.get(
    "SELECT sequence,policy_version FROM state_retention WHERE id=1",
  );
  if (
    !row ||
    !Number.isSafeInteger(Number(row.sequence)) ||
    Number(row.sequence) < 0 ||
    Number(row.policy_version) !== 1
  )
    refuse();
  if (
    Number(
      db.get("SELECT COALESCE(MAX(sequence),0) AS n FROM state_events")?.n,
    ) > Number(row.sequence)
  )
    refuse();
  if (
    db.get(
      "SELECT 1 FROM state_events e LEFT JOIN state_namespace_watermarks w ON e.namespace=w.namespace WHERE w.sequence IS NULL OR e.sequence>w.sequence LIMIT 1",
    )
  )
    refuse();
  if (
    db.get(
      "SELECT 1 FROM state_namespace_watermarks WHERE sequence>? LIMIT 1",
      [row.sequence!],
    )
  )
    refuse();
  for (const usage of db.all("SELECT table_name,rows,bytes FROM state_usage")) {
    const table = String(usage.table_name);
    identifier(table);
    const columns = tables[table];
    if (!columns) refuse();
    const actual = db.get(
      `SELECT COUNT(*) AS rows, COALESCE(SUM(${bytes(columns)}),0) AS bytes FROM ${identifier(table)}`,
    );
    if (
      !actual ||
      ["rows", "bytes"].some(
        (k) =>
          !Number.isSafeInteger(Number(usage[k])) ||
          Number(usage[k]) < 0 ||
          Number(actual[k]) !== Number(usage[k]),
      )
    )
      refuse();
  }
  for (const table of Object.keys(tables))
    if (!db.get("SELECT 1 FROM state_usage WHERE table_name=?", [table]))
      refuse();
}

export const stateMigrations: readonly Migration[] = [
  baseline,
  eventKeyIndex,
  deviceSessionIdentity,
  {
    id: "004_state_checkpoint",
    statements: Object.entries(checkpointTables).map(
      ([table, columns]) => `CREATE TABLE IF NOT EXISTS ${table} (${columns})`,
    ),
  },
  {
    id: "005_state_events_namespace_index",
    statements: [
      "CREATE INDEX IF NOT EXISTS state_events_by_namespace ON state_events (namespace, sequence)",
    ],
  },
  {
    id: "006_state_retention",
    statements: [
      "CREATE TABLE state_retention (id INTEGER PRIMARY KEY CHECK(id=1), sequence INTEGER NOT NULL CHECK(sequence>=0), policy_version INTEGER NOT NULL CHECK(policy_version>0))",
      "INSERT INTO state_retention SELECT 1, COALESCE(MAX(sequence),0), 1 FROM state_events",
      "CREATE TABLE state_namespace_watermarks (namespace TEXT PRIMARY KEY NOT NULL, sequence INTEGER NOT NULL CHECK(sequence>=0))",
      "INSERT INTO state_namespace_watermarks SELECT namespace, MAX(sequence) FROM state_events GROUP BY namespace",
      "CREATE TABLE state_allocation_keys (namespace TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY(namespace,key))",
      "INSERT OR IGNORE INTO state_allocation_keys SELECT namespace,key FROM state_records",
      "INSERT OR IGNORE INTO state_allocation_keys SELECT namespace,key FROM state_events WHERE json_extract(body,'$.type') IN (namespace||':record.updated@1',namespace||':record.deleted@1')",
      "CREATE TRIGGER retention_allocation AFTER INSERT ON state_events WHEN CASE WHEN json_valid(NEW.body) THEN json_extract(NEW.body,'$.type') IN (NEW.namespace||':record.updated@1',NEW.namespace||':record.deleted@1') ELSE 0 END BEGIN INSERT OR IGNORE INTO state_allocation_keys VALUES (NEW.namespace,NEW.key); END",
      "CREATE TABLE state_usage (table_name TEXT PRIMARY KEY NOT NULL, rows INTEGER NOT NULL CHECK(rows>=0), bytes INTEGER NOT NULL CHECK(bytes>=0))",
      ...requestAgeStatements("state_requests"),
      ...usageStatements(stateColumns),
      "CREATE TRIGGER retention_event AFTER INSERT ON state_events BEGIN UPDATE state_retention SET sequence=MAX(sequence,NEW.sequence) WHERE id=1; INSERT INTO state_namespace_watermarks VALUES (NEW.namespace,NEW.sequence) ON CONFLICT(namespace) DO UPDATE SET sequence=MAX(sequence,excluded.sequence); END",
    ],
  },
  {
    id: "007_record_checkpoint",
    statements: [
      "ALTER TABLE state_checkpoint_live ADD COLUMN body TEXT NOT NULL DEFAULT ''",
    ],
  },
  // Older writers cannot preserve checkpoint deletion revisions after prefix restoration.
  { id: "008_record_checkpoint_reader", statements: ["SELECT 1"] },
  {
    id: "009_checkpoint_compaction",
    statements: [
      "ALTER TABLE state_checkpoint_header ADD COLUMN commitment TEXT NOT NULL DEFAULT ''",
      `CREATE TRIGGER state_compaction_tail BEFORE INSERT ON state_events WHEN EXISTS(SELECT 1 FROM state_checkpoint_header WHERE archive_through>0) AND EXISTS(SELECT 1 FROM state_usage WHERE table_name='state_events' AND (rows>=8192 OR bytes+(${bytes(stateColumns.state_events!, "NEW.")})>8388608)) BEGIN SELECT RAISE(ABORT,'CHECKPOINT_MAINTENANCE_REQUIRED'); END`,
    ],
  },
];

export function identifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value))
    throw new Error("Invalid SQL identifier");
  return `"${value}"`;
}

export function execMigrationStatement(db: SqlDatabase, sql: string): void {
  const match = /^\s*ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)\b/i.exec(sql);
  const exists = (): boolean =>
    db
      .all(`PRAGMA table_info(${identifier(match![1]!)})`)
      .some((row) => row.name === match![2]);
  if (match && exists()) return;
  try {
    db.exec(sql);
  } catch (error) {
    if (match) {
      try {
        if (exists()) return;
      } catch {
        throw error;
      }
    }
    throw error;
  }
}

/** Refuses a schema whose complete applied ledger this binary cannot interpret. */
export class NewerStoreError extends Error {
  readonly newestKnownVersion: string;
  readonly foundVersion: string;
  constructor(newestKnownVersion: string, foundVersion: string) {
    super(
      `Store written by a newer Forge: newest known ${newestKnownVersion}; found ${foundVersion}`,
    );
    this.name = "NewerStoreError";
    this.newestKnownVersion = newestKnownVersion;
    this.foundVersion = foundVersion;
  }
}

export function migrate(
  db: SqlDatabase,
  migrations: readonly Migration[] = stateMigrations,
  after?: () => void,
  admit?: () => void,
): void {
  const ids = new Set<string>();
  for (const migration of migrations) {
    identifier(migration.id.replace(/^[0-9]+_/, "m_"));
    if (ids.has(migration.id) || migration.statements.length === 0)
      throw new Error("Invalid migration sequence");
    ids.add(migration.id);
  }
  db.transaction(() => {
    const newestKnown = [...ids].sort().at(-1) ?? "none";
    const schemaVersion = Number(
      db.get("PRAGMA user_version")?.user_version ?? 0,
    );
    if (schemaVersion > 0)
      throw new NewerStoreError(newestKnown, `schema:${schemaVersion}`);
    if (
      db.get(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='state_migrations'",
      )
    ) {
      const unknown = db
        .all("SELECT id FROM state_migrations ORDER BY id")
        .map((row) => String(row.id))
        .filter((id) => !ids.has(id))
        .at(-1);
      if (unknown !== undefined)
        throw new NewerStoreError(newestKnown, unknown);
    } else {
      admit?.();
      db.exec(
        "CREATE TABLE IF NOT EXISTS state_migrations (id TEXT PRIMARY KEY NOT NULL)",
      );
    }
    for (const migration of migrations) {
      if (db.get("SELECT id FROM state_migrations WHERE id=?", [migration.id]))
        continue;
      admit?.();
      for (const sql of migration.statements) execMigrationStatement(db, sql);
      db.run("INSERT INTO state_migrations(id) VALUES (?)", [migration.id]);
    }
    after?.();
  });
}
