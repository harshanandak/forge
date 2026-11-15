// Expected-image replay and independent lease-release expectations for conformance.
import assert from "node:assert/strict";
import { LaneControlStore } from "../src/lane-control-store.ts";
import { LANE_APPROVALS } from "../src/lane-approval.ts";
import { LANE_BROWSER } from "../src/auth/lane-browser.ts";
import type { LaneControlGlobal } from "../../src/blocks/work/lane-control.ts";
import { digests, fold, tally, type Table } from "./digest.ts";
import { canonicalJson } from "../../src/core/config/pointer.ts";
import type {
  LeaseRecord,
  StateEvent,
  StateRecord,
} from "../../src/generated/types.ts";
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

export interface StopDelta {
  at: string;
  incarnation: string;
  auditId: string;
  window: readonly [number, number];
}
export interface StopPlan {
  prior: Tables[string][number] | undefined;
  records: Tables[string];
  events: Tables[string];
}
const stopGlobal = (row: Record<string, unknown>) =>
  row.namespace === "forge/work" && row.key === "lane-control:global";

/** Render only the two generated pairs; clocks and UUIDs are explicit, independently checked inputs. */
export function stopPlan(
  before: Tables,
  delta?: StopDelta,
): StopPlan | undefined {
  if (!delta) return;
  const { at, incarnation, auditId, window } = delta;
  const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
  assert.match(incarnation, uuid);
  assert.match(auditId, uuid);
  assert.equal(new Date(at).toISOString(), at, "stop ISO clock");
  assert.ok(
    window[0] <= Date.parse(at) && Date.parse(at) <= window[1],
    "stop request window",
  );
  const namespace = "forge/work",
    key = `lane-control:audit:${auditId}`;
  assert.ok(
    ![before.state_records!, before.state_events!].some((rows) =>
      rows.some((row) => row.namespace === namespace && row.key === key),
    ),
    "stop audit key is fresh",
  );
  const priorRow = before.state_records!.find(stopGlobal);
  const prior = priorRow
    ? ((JSON.parse(String(priorRow.body)) as StateRecord)
        .value as LaneControlGlobal)
    : undefined;
  if (prior) assert.equal(incarnation, prior.incarnation, "stop incarnation");
  const revision =
    Number(
      priorRow?.revision ??
        before.state_events!.reduce((n, row) => {
          if (!stopGlobal(row)) return n;
          const event = JSON.parse(String(row.body)) as StateEvent;
          return event.type === "forge/work:record.updated@1" ||
            event.type === "forge/work:record.deleted@1"
            ? Math.max(n, event.revision)
            : n;
        }, 0),
    ) + 1;
  const epoch = (prior?.epoch ?? 0) + 1;
  assert.ok(
    Number.isSafeInteger(epoch) && Number.isSafeInteger(revision),
    "stop epoch/revision",
  );
  const actor = { kind: "agent", id: "cloud-restore" } as const;
  const values = [
    {
      ...(prior ?? { version: 1, incarnation, resumeAllEpoch: 0 }),
      epoch,
      stopAll: at,
    },
    {
      version: 1,
      action: "stop",
      scope: { all: true },
      device: "cloud-restore",
      session: "cloud-restore",
      at,
      incarnation,
      epoch,
    },
  ];
  const keys = ["lane-control:global", key];
  const records = values.map((value, i) => ({
    namespace,
    key: keys[i]!,
    revision: i ? 1 : revision,
    body: canonicalJson({
      namespace,
      key: keys[i],
      revision: i ? 1 : revision,
      value,
      updatedAt: at,
      updatedBy: actor,
    }),
  }));
  const high = Number(before.state_events!.at(-1)?.sequence ?? 0);
  assert.ok(Number.isSafeInteger(high + 2), "stop event sequence");
  const events = records.map((row, i) => ({
    sequence: high + i + 1,
    namespace,
    key: row.key,
    body: canonicalJson({
      type: `${namespace}:record.updated@1`,
      namespace,
      key: row.key,
      revision: row.revision,
      at,
      actor,
      data: values[i],
    }),
  }));
  return { prior: priorRow, records, events };
}

/** References to existing payloads plus two small pairs; the none case returns the original image. */
export function stopOverlay(before: Tables, plan?: StopPlan): Tables {
  if (!plan) return before;
  const records = before.state_records!.filter((row) => !stopGlobal(row));
  for (const row of plan.records) {
    const at = records.findIndex((other) =>
      other.namespace === row.namespace
        ? String(other.key) > row.key!
        : String(other.namespace) > row.namespace!,
    );
    records.splice(at < 0 ? records.length : at, 0, row);
  }
  return {
    ...before,
    state_records: records,
    state_events: [...before.state_events!, ...plan.events],
  };
}

/** Remove only the independently rendered identities, restoring the original global at its exact key. */
export function stopProof(plan: StopPlan) {
  const seen = [0, 0, 0, 0];
  return {
    row(
      table: string,
      row: Record<string, unknown>,
    ): Record<string, unknown> | undefined {
      const list =
        table === "state_records"
          ? plan.records
          : table === "state_events"
            ? plan.events
            : [];
      const i = list.findIndex((want) =>
        table === "state_records"
          ? row.namespace === want.namespace && row.key === want.key
          : row.sequence === want.sequence,
      );
      if (i < 0) return row;
      const index = i + (table === "state_events" ? 2 : 0);
      assert.deepEqual(
        { ...row },
        list[i],
        `stop ${table} ${i}: exact generated row`,
      );
      seen[index]!++;
      return table === "state_records" && i === 0 ? plan.prior : undefined;
    },
    done() {
      assert.deepEqual(seen, [1, 1, 1, 1], "stop pair counts");
    },
  };
}

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
