import type { Database } from "bun:sqlite";
import type { DurableStorage } from "../../cloud/src/store.ts";

/** Shared by device login and lane browser tables, with optional write fault injection. */
export function browserStorage(db: Database, before = (_sql: string) => {}) {
  const values = new Map<string, unknown>();
  const storage: DurableStorage = {
    sql: {
      exec: (sql, ...bindings) => {
        before(sql);
        const rows = db
          .query(sql)
          .all(
            ...bindings.map((value) =>
              value instanceof ArrayBuffer ? new Uint8Array(value) : value,
            ),
          ) as Record<string, unknown>[];
        return { toArray: () => rows };
      },
    },
    transactionSync: (run) => db.transaction(run)(),
    get: (key) => Promise.resolve(values.get(key)),
    put: (key, value) => {
      values.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => Promise.resolve(values.delete(key)),
  };
  return { storage, values };
}
