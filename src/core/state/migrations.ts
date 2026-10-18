import type { SqlDatabase } from "../../ports/store.ts";

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

export function migrate(
  db: SqlDatabase,
  migrations: readonly Migration[] = [baseline],
  after?: () => void,
): void {
  const ids = new Set<string>();
  for (const migration of migrations) {
    identifier(migration.id.replace(/^[0-9]+_/, "m_"));
    if (ids.has(migration.id) || migration.statements.length === 0)
      throw new Error("Invalid migration sequence");
    ids.add(migration.id);
  }
  db.transaction(() => {
    db.exec(
      "CREATE TABLE IF NOT EXISTS state_migrations (id TEXT PRIMARY KEY NOT NULL)",
    );
    for (const migration of migrations) {
      if (db.get("SELECT id FROM state_migrations WHERE id=?", [migration.id]))
        continue;
      for (const sql of migration.statements) execMigrationStatement(db, sql);
      db.run("INSERT INTO state_migrations(id) VALUES (?)", [migration.id]);
    }
    after?.();
  });
}
