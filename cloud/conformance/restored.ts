// Expected-image replay and independent lease-release expectations for conformance.
import { canonicalJson } from "../../src/core/config/pointer.ts";
import type { LeaseRecord } from "../../src/generated/types.ts";
import type { Tables } from "./max-source.ts";
import { StateOwner } from "../../src/core/state/index.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import { durableStore } from "../src/store.ts";
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
  // Load the Bun fixture only when constructing an image; Node digest readers share this module.
  const { scratchStorage } = await import("./max-source.ts");
  const scratch = scratchStorage();
  try {
    const db = durableStore(scratch.storage);
    const owner = replayImage(db, source, at);
    await delta(owner);
    const limits = {
      ...limitsFrom({}),
      maxBytes: Number.MAX_SAFE_INTEGER,
      maxRows: Number.MAX_SAFE_INTEGER,
    };
    yield* pagesOf(db, limits);
  } finally {
    scratch.db.close();
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
