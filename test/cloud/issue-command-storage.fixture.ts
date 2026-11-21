import type { Database } from "bun:sqlite";

export const issueStoreSnapshot = (
  db: Database,
  values: ReadonlyMap<string, unknown>,
) =>
  JSON.stringify({
    sql: db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY 1",
      )
      .all()
      .map(({ name }) => [name, db.query(`SELECT * FROM "${name}"`).all()]),
    kv: [...values.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  });
