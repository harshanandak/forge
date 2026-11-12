import type { SqlDatabase, SqlValue } from "../../../src/ports/store.ts";
import type { Actor, StateRecord } from "../../../src/generated/types.ts";

export type Access = {
  op: "get" | "all" | "run";
  sql: string;
  params: readonly SqlValue[];
  locked: boolean;
};
export type Hooks = {
  /** Runs once, just before the next write lock is requested. */
  entry?: (() => void) | undefined;
  /** A true answer makes that statement throw inside its transaction. */
  fail?: ((access: Access) => boolean) | undefined;
};

/** Wraps a database to log every statement with the lock state and to inject a peer or a fault. */
export function instrument(real: SqlDatabase) {
  const log: Access[] = [];
  const hooks: Hooks = {};
  let locked = false;
  const note = (
    op: Access["op"],
    sql: string,
    params: readonly SqlValue[] = [],
  ) => {
    const access = { op, sql, params, locked };
    log.push(access);
    return access;
  };
  const db: SqlDatabase = {
    exec: (sql) => real.exec(sql),
    all: (sql, params) => (note("all", sql, params), real.all(sql, params)),
    get: (sql, params) => (note("get", sql, params), real.get(sql, params)),
    run(sql, params) {
      if (hooks.fail?.(note("run", sql, params)))
        throw new Error("injected write failure");
      return real.run(sql, params);
    },
    transaction(work) {
      const entry = hooks.entry;
      hooks.entry = undefined;
      entry?.();
      return real.transaction(() => {
        locked = true;
        try {
          return work();
        } finally {
          locked = false;
        }
      });
    },
  };
  return { db, log, hooks };
}

export const reads = (log: readonly Access[]) =>
  log.filter((access) => access.op !== "run");
/** Reads of event history: any SELECT that names the event table. */
export const historyReads = (log: readonly Access[]) =>
  reads(log).filter((access) => access.sql.includes("state_events"));
/** A write statement into one table that carries the given record key. */
export const writesKey = (access: Access, table: string, key: string) =>
  access.op === "run" &&
  (access.sql.startsWith(`INSERT INTO ${table}`) ||
    access.sql.startsWith(`UPDATE ${table}`)) &&
  access.params.includes(key);

export type Built = {
  value: unknown;
  readSet?: readonly { key: string; expectRevision: number }[];
};
/** The numbered write is new; this type lets the tests-only commit compile before it exists. */
export type NumberedOwner = {
  putNext(
    namespace: string,
    prefix: string,
    build: (key: string, number: number) => Built,
    actor: Actor,
  ): StateRecord;
};
