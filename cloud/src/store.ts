// A synchronous SqlDatabase over a Durable Object's SQLite storage, so Forge's state owner runs
// in the Durable Object unchanged. Reads and writes go through ctx.storage.sql.exec; a transaction
// is ctx.storage.transactionSync, and a nested one joins the outer.
import type { SqlDatabase, SqlRow, SqlValue } from "../../src/ports/store.ts";

type Binding = string | number | null | ArrayBuffer;
export interface DurableState {
  readonly storage: DurableStorage;
}
export interface DurableStorage {
  readonly sql: {
    exec(
      statement: string,
      ...bindings: Binding[]
    ): { toArray(): Record<string, unknown>[] };
  };
  transactionSync<T>(body: () => T): T;
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<unknown>;
}

/** The only table that records the schema version: Durable Object SQLite has no PRAGMA user_version. */
export const PRAGMA_TABLE = "domain_cloud_pragma";

function bind(value: SqlValue): Binding {
  if (typeof value === "bigint") {
    // Integers past 2^53 would be read back as a different number, so they are never written.
    const n = Number(value);
    if (!Number.isSafeInteger(n))
      throw new RangeError("Unsafe integer refused");
    return n;
  }
  return value instanceof Uint8Array ? value.slice().buffer : value;
}

function synchronous<T>(body: () => T): T {
  const result = body();
  if (result instanceof Promise)
    throw new Error("A transaction body must be synchronous");
  return result;
}

/** The fixed probe the constructor of a read-only view runs, with the table name bound. */
export const TABLE_PROBE =
  "SELECT name FROM sqlite_schema WHERE type='table' AND name=?";

/**
 * A read-only view for a request that must not set anything up: it creates no table, runs no
 * migration and writes no row. Undefined when `table` does not exist yet.
 */
export function readOnlyStore(
  storage: DurableStorage,
  table: string,
  _statements: readonly string[],
): SqlDatabase | undefined {
  const all = (statement: string, params: readonly SqlValue[] = []) =>
    storage.sql.exec(statement, ...params.map(bind)).toArray() as SqlRow[];
  const refuse = (): never => {
    throw new Error("This view is read-only");
  };
  return all(TABLE_PROBE, [table]).length === 0
    ? undefined
    : {
        exec: refuse,
        run: refuse,
        transaction: refuse,
        all,
        get: (statement, params) => all(statement, params)[0],
      };
}

export function durableStore(storage: DurableStorage): SqlDatabase {
  const { sql } = storage;
  let active = false;
  let innerFailed = false;
  sql.exec(
    `CREATE TABLE IF NOT EXISTS ${PRAGMA_TABLE} (name TEXT PRIMARY KEY, value INTEGER NOT NULL)`,
  );
  sql.exec(`INSERT OR IGNORE INTO ${PRAGMA_TABLE} VALUES ('user_version', 0)`);

  const rows = (
    statement: string,
    params: readonly SqlValue[] = [],
  ): SqlRow[] => {
    const text = statement.trim();
    let run = statement;
    if (/^PRAGMA user_version$/i.test(text)) {
      run = `SELECT value AS user_version FROM ${PRAGMA_TABLE} WHERE name='user_version'`;
    } else if (/^PRAGMA user_version\s*=\s*\d+$/i.test(text)) {
      run = `UPDATE ${PRAGMA_TABLE} SET value=${Number(text.split("=")[1])} WHERE name='user_version'`;
    } else if (
      text === "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name"
    ) {
      // Tables owned by the runtime, not by Forge.
      run =
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT IN ('__miniflare_do_name','_cf_KV') ORDER BY name";
    }
    return sql
      .exec(run, ...params.map(bind))
      .toArray()
      .map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            value instanceof ArrayBuffer ? new Uint8Array(value) : value,
          ]),
        ),
      ) as SqlRow[];
  };

  return {
    exec(statement) {
      rows(statement);
    },
    run(statement, params = []) {
      rows(statement, params);
      const row = rows(
        "SELECT changes() AS changes, last_insert_rowid() AS id",
      )[0]!;
      return { changes: Number(row.changes), lastInsertRowid: Number(row.id) };
    },
    get: (statement, params = []) => rows(statement, params)[0],
    all: (statement, params = []) => rows(statement, params),
    transaction<T>(body: () => T): T {
      // A transaction inside another joins it: its writes commit or roll back with the outer one.
      // If the inner body throws, the outer one is marked failed and aborts even when its own code
      // catches that error, so a failed inner write is never committed.
      if (active) {
        try {
          return synchronous(body);
        } catch (error) {
          innerFailed = true;
          throw error;
        }
      }
      return storage.transactionSync(() => {
        active = true;
        innerFailed = false;
        try {
          const result = synchronous(body);
          if (innerFailed)
            throw new Error(
              "An inner transaction failed, so the outer one aborts",
            );
          return result;
        } finally {
          active = false;
          innerFailed = false;
        }
      });
    },
  };
}
