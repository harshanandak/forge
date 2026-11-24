import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  type BigIntStats,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type DatabaseSyncOptions } from "node:sqlite";
import type { HubDb, OpenHubDb } from "../contract/runtime.ts";
import { protectDirectoryChain } from "./protect.ts";
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

function reserveFile(path: string): BigIntStats {
  const fd = openSync(path, "wx", 0o600);
  try {
    return fstatSync(fd, { bigint: true });
  } finally {
    closeSync(fd);
  }
}

function assertIdentity(path: string, expected: BigIntStats): void {
  const current = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (
    !current?.isFile() ||
    current.nlink !== 1n ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino
  )
    throw new Error("Hub database file identity changed");
}

export function createOpenHubDb(
  connect: (path: string, options?: DatabaseSyncOptions) => DatabaseSync,
): OpenHubDb {
  return (path) => {
    const target = resolve(path);
    if (!protectDirectoryChain(dirname(target)))
      throw new Error("Hub database parent chain is unsafe");
    const existing = lstatSync(target, { bigint: true, throwIfNoEntry: false });
    if (existing !== undefined && (!existing.isFile() || existing.nlink !== 1n))
      throw new Error("Hub database path must be a regular file with one link");
    const expected = existing ?? reserveFile(target);
    if (expected.ino === 0n)
      throw new Error("Hub database file identity is unavailable");
    if (expected.size > 0n) {
      const probe = handle(connect(target, { readOnly: true }));
      try {
        assertIdentity(target, expected);
        probe.exec("PRAGMA busy_timeout=5000");
        schemaVersion(probe);
      } finally {
        probe.close();
      }
    }
    assertIdentity(target, expected);
    const db = handle(connect(target));
    try {
      assertIdentity(target, expected);
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
}

export const openHubDb = createOpenHubDb(
  (path, options) => new DatabaseSync(path, options),
);
