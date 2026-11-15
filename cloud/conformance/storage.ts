// Driver calls only; production durableStore owns joined, failure-poisoned transactions.
import type { Database } from "bun:sqlite";
import type { DatabaseSync } from "node:sqlite";
import type { DurableStorage } from "../src/store.ts";
type SQLite = Database | DatabaseSync;

export function scratchStorage<T extends SQLite>(
  Driver: new (path: string) => T,
) {
  const db = new Driver(":memory:");
  return { db, ...storageOf(db) };
}

/** Durable Object style storage over either SQLite driver, counting the statements it runs. */
export function storageOf(
  db: SQLite,
  count = { n: 0 },
  before = (_sql: string) => {},
) {
  const values = new Map<string, unknown>();
  let depth = 0;
  const storage: DurableStorage = {
    sql: {
      exec: (statement, ...bindings) => {
        count.n += 1;
        before(statement);
        const rows = db
          .prepare(statement)
          .all(
            ...(bindings.map((b) =>
              b instanceof ArrayBuffer ? new Uint8Array(b) : b,
            ) as never[]),
          ) as Record<string, unknown>[];
        return { toArray: () => rows };
      },
    },
    transactionSync: (body) => {
      const outer = depth === 0;
      if (outer) db.exec("BEGIN");
      depth += 1;
      try {
        const result = body();
        if (outer) db.exec("COMMIT");
        return result;
      } catch (error) {
        if (outer) db.exec("ROLLBACK");
        throw error;
      } finally {
        depth -= 1;
      }
    },
    get: (key) => Promise.resolve(values.get(key)),
    put: (key, value) => {
      values.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => Promise.resolve(values.delete(key)),
  };
  return { storage, values };
}
