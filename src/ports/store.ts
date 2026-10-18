// The storage driver port under the single state owner. Only src/core/state uses it; no block ever
// opens SQL. Both runtime SQLite bindings are synchronous, so this port is too.
import type { LifetimeProvider } from "./lifetime.ts";

export type SqlValue = null | number | bigint | string | Uint8Array;
export type SqlRow = Readonly<Record<string, SqlValue>>;

export interface SqlRunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

export interface SqlDatabase {
  exec(sql: string): void;
  run(sql: string, params?: readonly SqlValue[]): SqlRunResult;
  get(sql: string, params?: readonly SqlValue[]): SqlRow | undefined;
  all(sql: string, params?: readonly SqlValue[]): readonly SqlRow[];
  /** Runs `body` in one immediate transaction; a throw rolls everything back. */
  transaction<T>(body: () => T): T;
}

export interface StoreOpenOptions {
  readonly path: string;
  readonly readOnly: boolean;
}

export type StorePort = LifetimeProvider<SqlDatabase, StoreOpenOptions>;
