import { lstatSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { HubDb, OpenHubDb } from "../contract/runtime.ts";
import { migrate, schemaVersion } from "./schema.ts";

function handle(raw: DatabaseSync): HubDb {
  let active = false;
  return {
    exec: raw.exec.bind(raw),
    prepare: raw.prepare.bind(raw),
    transaction<T>(work: () => T): T {
      if (active) throw new Error("Nested transactions are refused");
      raw.exec("BEGIN IMMEDIATE");
      active = true;
      try {
        const result = work();
        if (
          result !== null &&
          (typeof result === "object" || typeof result === "function") &&
          "then" in result
        )
          throw new Error("Transaction body must be synchronous");
        raw.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          raw.exec("ROLLBACK");
        } catch (rollback) {
          throw new AggregateError(
            [error, rollback],
            "Transaction and rollback failed",
            { cause: rollback },
          );
        }
        throw error;
      } finally {
        active = false;
      }
    },
    close: raw.close.bind(raw),
  };
}

export const openHubDb: OpenHubDb = (path) => {
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (existing !== undefined && !existing.isFile())
    throw new Error("Hub database path must be a regular file");
  if (existing !== undefined && existing.size > 0) {
    const probe = handle(new DatabaseSync(path, { readOnly: true }));
    try {
      probe.exec("PRAGMA busy_timeout=5000");
      schemaVersion(probe);
    } finally {
      probe.close();
    }
  }
  const db = handle(new DatabaseSync(path));
  try {
    db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    if (schemaVersion(db) === 0) migrate(db);
    const wal = db.prepare("PRAGMA journal_mode=WAL").get();
    if (wal?.journal_mode !== "wal")
      throw new Error("Hub database requires WAL mode");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
};
