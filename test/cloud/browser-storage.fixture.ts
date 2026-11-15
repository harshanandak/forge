import type { Database } from "bun:sqlite";
import { storageOf } from "../../cloud/conformance/storage.ts";

/** Shared by device login and lane browser tables, with optional write fault injection. */
export const browserStorage = (db: Database, before = (_sql: string) => {}) =>
  storageOf(db, undefined, before);
