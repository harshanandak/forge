// Expected-image replay and independent lease-release expectations for conformance.
import { canonicalJson } from "../../src/core/config/pointer.ts";
import type { LeaseRecord } from "../../src/generated/types.ts";
import type { Tables } from "./max-source.ts";
import { StateOwner } from "../../src/core/state/index.ts";
import type { SqlDatabase, SqlRow } from "../../src/ports/store.ts";
import { sqliteStore } from "../../src/adapters/store-sqlite/index.ts";
import { initializeCloudVersion } from "../src/store.ts";
import { pagesOf } from "../../tools/import-current-state.ts";
import { domain } from "../src/project.ts";
import {
  limitsFrom,
  DUMP_FORMAT,
  PAGE_FORMAT,
  restoreDump,
  restorePage,
  type Dump,
  type Page,
} from "../src/dump.ts";

export class IncompleteImageError extends Error {
  readonly code = "INCOMPLETE_IMAGE";
}

/** Native SQLite returns bigint; the Cloud dump path receives safe integer numbers. */
export function dumpReadView(db: SqlDatabase): SqlDatabase {
  const row = (given: SqlRow): SqlRow =>
    Object.fromEntries(
      Object.entries(given).map(([key, value]) => [
        key,
        typeof value === "bigint" && Number.isSafeInteger(Number(value))
          ? Number(value)
          : value,
      ]),
    );
  return {
    ...db,
    all: (sql, params) => db.all(sql, params).map(row),
    get: (sql, params) => {
      const given = db.get(sql, params);
      return given === undefined ? undefined : row(given);
    },
  };
}
export function imageSequence(whole = false) {
  let next = 0,
    complete = false;
  return (part?: Pick<Partial<Page>, "format" | "page" | "last" | "next">) => {
    if (part === undefined) {
      if (!complete)
        throw new IncompleteImageError("Expected image did not finish");
      return;
    }
    const dump = whole && part.format === DUMP_FORMAT;
    if (
      complete ||
      (dump
        ? next++ !== 0
        : part.format !== PAGE_FORMAT ||
          part.page !== next++ ||
          (part.next !== null && typeof part.next !== "string") ||
          part.last !== (part.next === null))
    )
      throw new IncompleteImageError("Expected image pages are out of order");
    complete = dump || part.last === true;
  };
}

/** The caller owns an empty scratch store and may prepare a different expected image after replay. */
export function replayImage(
  db: SqlDatabase,
  image: Iterable<Dump | Page>,
  at: number | (() => number),
): StateOwner {
  initializeCloudVersion((sql) => db.exec(sql));
  const owner = new StateOwner(db, {
    now: typeof at === "number" ? () => at : at,
  });
  owner.initialize([domain]);
  const limits = {
    ...limitsFrom({}),
    maxRows: Number.MAX_SAFE_INTEGER,
    maxBytes: Number.MAX_SAFE_INTEGER,
  };
  const sequence = imageSequence(true);
  for (const part of image) {
    sequence(part);
    if ("page" in part) restorePage(db, owner, part, limits);
    else restoreDump(db, owner, part, limits);
  }
  sequence();
  return owner;
}

/** Own the scratch lifetime while streaming a replay plus a caller-supplied delta. */
export async function* expectedImage(
  source: Iterable<Dump | Page>,
  at: number | (() => number),
  delta: (owner: StateOwner) => void | Promise<void>,
): AsyncGenerator<Page> {
  const opened = await sqliteStore.open({ path: ":memory:", readOnly: false });
  if (!opened.ok) throw new Error("Expected-image scratch storage unavailable");
  const { handle } = opened;
  try {
    const db = dumpReadView(handle.value);
    const owner = replayImage(db, source, at);
    await delta(owner);
    const limits = {
      ...limitsFrom({}),
      maxBytes: Number.MAX_SAFE_INTEGER,
      maxRows: Number.MAX_SAFE_INTEGER,
    };
    yield* pagesOf(db, limits);
  } finally {
    await handle.close();
  }
}

export const releaseEvent = (
  namespace: string,
  lease: LeaseRecord,
  at: string,
) => ({
  type: `${namespace}:lease.released@1`,
  namespace,
  key: lease.subject,
  revision: lease.generation,
  at,
  actor: lease.holder.actor,
  data: { ...lease, releasedAt: at },
});
export function releasedTables(source: Tables, at: string, floors = 0): Tables {
  const tables = structuredClone(source);
  for (const row of tables.state_leases!) {
    const lease = JSON.parse(String(row.body)) as LeaseRecord;
    if (
      lease.releasedAt !== undefined ||
      Date.parse(lease.expiresAt) <= Date.parse(at)
    )
      continue;
    const event = releaseEvent(String(row.namespace), lease, at);
    row.body = canonicalJson(event.data);
    tables.state_events!.push({
      sequence: tables.state_events!.length + floors + 1,
      namespace: row.namespace!,
      key: row.subject!,
      body: canonicalJson(event),
    });
  }
  return tables;
}
