// Expected-image replay and independent lease-release expectations for conformance.
import assert from "node:assert/strict";
import { LaneControlStore } from "../src/lane-control-store.ts";
import { LANE_APPROVALS } from "../src/lane-approval.ts";
import { LANE_BROWSER } from "../src/auth/lane-browser.ts";
import type { LaneControlGlobal } from "../../src/blocks/work/lane-control.ts";
import { digests, fold, tally, type Table } from "./digest.ts";
import { canonicalJson } from "../../src/core/config/pointer.ts";
import type { LeaseRecord, StateEvent } from "../../src/generated/types.ts";
import type { Tables } from "./max-source.ts";
import { StateOwner } from "../../src/core/state/index.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import { durableStore } from "../src/store.ts";
import { scratchStorage } from "./storage.ts";
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
  at: number | ((db: SqlDatabase) => number),
  delta: (owner: StateOwner) => void | Promise<void>,
): AsyncGenerator<Page> {
  const Driver =
    typeof Bun === "undefined"
      ? (await import("node:sqlite")).DatabaseSync
      : (await import("bun:sqlite")).Database;
  const scratch = scratchStorage<
    import("bun:sqlite").Database | import("node:sqlite").DatabaseSync
  >(Driver);
  try {
    const db = durableStore(scratch.storage);
    const owner = replayImage(
      db,
      source,
      typeof at === "number" ? at : () => at(db),
    );
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
/** The caller captures restoreWindow around the final request, independently of the target image. */
export async function restoreStopped(
  source: Iterable<Dump | Page>,
  actual: SqlDatabase,
  project: string,
  restoreWindow: readonly [number, number],
): Promise<void> {
  const namespace = "forge/work",
    key = "lane-control:global";
  const target = new StateOwner(actual, { now: Date.now });
  const control = new LaneControlStore(target, project).read();
  const problems =
    control.ok && control.result.stopped && control.result.scope === "all"
      ? []
      : ["missing global stop"];
  for (const table of [LANE_APPROVALS, LANE_BROWSER])
    if (Number(actual.get(`SELECT COUNT(*) AS n FROM ${table}`)!.n) !== 0)
      problems.push(`${table} is not empty`);
  assert.equal(problems.length, 0, problems.join("; "));
  assert.ok(control.ok);
  const global = target.get(namespace, key)!;
  const last = actual.get(
    "SELECT body FROM state_events ORDER BY sequence DESC LIMIT 1",
  )!;
  const audit = JSON.parse(String(last.body)) as StateEvent;
  const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
  assert.match(audit.key, /^lane-control:audit:/);
  const auditId = audit.key.slice("lane-control:audit:".length);
  assert.match(auditId, uuid);
  assert.deepEqual(audit.data, {
    version: 1,
    action: "stop",
    scope: { all: true },
    device: "cloud-restore",
    session: "cloud-restore",
    at: global.updatedAt,
    incarnation: control.result.incarnation,
    epoch: control.result.epoch,
  });
  assert.equal(new Date(global.updatedAt).toISOString(), global.updatedAt);
  const time = (stamp: string) => {
    const at = Date.parse(stamp);
    assert.ok(
      restoreWindow[0] <= at && at <= restoreWindow[1],
      "restore stop time window",
    );
    return at;
  };
  [
    global.updatedAt,
    target.get(namespace, audit.key)!.updatedAt,
    audit.at,
    (global.value as LaneControlGlobal).stopAll!,
  ].forEach(time);
  const limits = {
    ...limitsFrom({}),
    maxRows: Number.MAX_SAFE_INTEGER,
    maxBytes: Number.MAX_SAFE_INTEGER,
  };
  const hash = async (image: Iterable<Page> | AsyncIterable<Page>) => {
    const sum = tally();
    for await (const page of image)
      for (const [table, rows] of Object.entries(page.tables))
        rows.forEach((row) => fold(sum, table as Table, row));
    return digests(sum);
  };
  const got = await hash(pagesOf(actual, limits));
  assert.deepEqual(
    await hash(expectedImage(pagesOf(actual, limits), Date.now, () => {})),
    got,
    "complete target replay",
  );
  const expected = expectedImage(
    source,
    (db) => {
      const n = Number(
        db.get("SELECT MAX(sequence) AS n FROM state_events")!.n,
      );
      const next = actual.get(
        "SELECT json_extract(body,'$.at') AS at FROM state_events WHERE sequence=?",
        [n + 1],
      );
      return time(String(next?.at ?? global.updatedAt));
    },
    (owner) => {
      const prior = owner.get(namespace, key)?.value as
        LaneControlGlobal | undefined;
      assert.equal(
        control.result.epoch,
        (prior?.epoch ?? 0) + 1,
        "restore stop epoch",
      );
      if (prior) assert.equal(control.result.incarnation, prior.incarnation);
      else assert.match(control.result.incarnation, uuid);
      const original = crypto.randomUUID.bind(crypto);
      const ids = [control.result.incarnation, auditId];
      try {
        // Only generated UUIDs and observed clock inputs are aligned; all six tables remain in the comparison.
        crypto.randomUUID = () => ids.shift()! as ReturnType<typeof original>;
        assert.ok(
          new LaneControlStore(owner, project).stop(
            { all: true },
            "cloud-restore",
            "cloud-restore",
            global.updatedAt,
          ).ok,
        );
      } finally {
        crypto.randomUUID = original;
      }
    },
  );
  assert.deepEqual(await hash(expected), got, "source plus restore stop");
}
