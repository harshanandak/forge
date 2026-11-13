// What a capacity run expects a restored project to hold, computed from the source tables by raw SQL before anything is
// exported (forge-1040). The same fold checks a node:sqlite target in capacity.ts and the Worker read back in
// conformance.ts, page by page, so no run keeps a whole project in memory.
import { createHash, type Hash } from "node:crypto";
import assert from "node:assert/strict";
import { canonicalJson } from "../../src/core/config/pointer.ts";
import type { LeaseRecord, StateEvent } from "../../src/generated/types.ts";
import { releaseEvent } from "./restored.ts";

export const TABLES = [
  "state_records",
  "state_events",
  "state_leases",
  "state_requests",
  "domain_cloud_requests",
  "domain_cloud_command_receipts",
] as const;
export type Table = (typeof TABLES)[number];
// The columns a dump carries, and each table's key in dump order: the order every digest is taken in.
export const COLUMNS: Record<Table, string[]> = {
  state_records: ["namespace", "key", "revision", "body"],
  state_events: ["sequence", "namespace", "key", "body"],
  state_leases: ["namespace", "subject", "generation", "body"],
  state_requests: ["namespace", "request_id", "fingerprint", "result"],
  domain_cloud_requests: ["request_id", "fingerprint", "outcome", "result"],
  domain_cloud_command_receipts: [
    "request_id",
    "fingerprint",
    "outcome",
    "result",
    "created_at",
    "expires_at",
  ],
};
export const KEYS: Record<Table, string[]> = {
  state_records: ["namespace", "key"],
  state_events: ["sequence"],
  state_leases: ["namespace", "subject"],
  state_requests: ["namespace", "request_id"],
  domain_cloud_requests: ["request_id"],
  domain_cloud_command_receipts: ["request_id"],
};
// The issue number floor a restore writes (one record and one event) when the dump has none.
export const FLOOR = { namespace: "forge/work", key: "allocation:issue:work-" };

export interface Expected {
  floorSupplied: boolean;
  lastSequence: number;
  tables: Record<Table, { rows: number; digest: string }>;
}
export interface Tally {
  rows: Record<Table, number>;
  hashes: Record<Table, Hash>;
  generated: { records: number; events: number; releases: number };
  releaseHash: Hash;
  // Set for a restored target: its generated floor rows are counted apart and left out of the digests.
  skip: Pick<Expected, "floorSupplied" | "lastSequence"> | undefined;
}
type Row = Record<string, unknown>;

export function tally(skip?: Tally["skip"]): Tally {
  const each = <T>(make: () => T): Record<Table, T> =>
    Object.fromEntries(TABLES.map((t) => [t, make()])) as Record<Table, T>;
  return {
    rows: each(() => 0),
    hashes: each(() => createHash("sha256")),
    generated: { records: 0, events: 0, releases: 0 },
    releaseHash: createHash("sha256"),
    skip,
  };
}

const encoded = (table: Table, row: Row): string =>
  `${JSON.stringify(COLUMNS[table].map((column) => row[column]))}\n`;
// Capacity fixtures contain live leases only; compare every original byte after checking release metadata.
function originalLease(value: unknown): LeaseRecord {
  const { releasedAt, ...lease } = value as LeaseRecord;
  assert.ok(
    releasedAt &&
      Number.isFinite(Date.parse(releasedAt)) &&
      Date.parse(releasedAt) <= Date.now(),
  );
  return lease;
}

/** Preserve source digests while checking generated floor rows and exact lease releases separately. */
export function fold(t: Tally, table: Table, row: Row): void {
  if (t.skip !== undefined) {
    if (
      table === "state_records" &&
      !t.skip.floorSupplied &&
      row.namespace === FLOOR.namespace &&
      row.key === FLOOR.key
    ) {
      t.generated.records += 1;
      return;
    }
    if (
      table === "state_events" &&
      Number(row.sequence) > t.skip.lastSequence
    ) {
      const event = JSON.parse(String(row.body)) as StateEvent;
      if (event.type.endsWith(":lease.released@1")) {
        const lease = originalLease(event.data);
        assert.deepEqual(
          event,
          releaseEvent(String(row.namespace), lease, event.at),
        );
        t.generated.releases++;
        t.releaseHash.update(
          encoded("state_leases", {
            namespace: row.namespace,
            subject: row.key,
            generation: event.revision,
            body: canonicalJson(lease),
          }),
        );
      } else t.generated.events += 1;
      return;
    }
  }
  if (t.skip !== undefined && table === "state_leases")
    row = {
      ...row,
      body: canonicalJson(
        originalLease(JSON.parse(String(row.body)) as unknown),
      ),
    };
  t.rows[table] += 1;
  t.hashes[table].update(encoded(table, row));
}

export function digests(t: Tally): Expected["tables"] {
  return Object.fromEntries(
    TABLES.map((table) => [
      table,
      { rows: t.rows[table], digest: t.hashes[table].digest("hex") },
    ]),
  ) as Expected["tables"];
}

/** Every way a restored target differs from what the source held; empty when it matches. */
export function problems(t: Tally, expected: Expected): string[] {
  const found: string[] = [];
  const floors = expected.floorSupplied ? 0 : 1;
  for (const [what, have] of [
    ["floor records", t.generated.records],
    ["floor events", t.generated.events],
  ] as const)
    if (have !== floors)
      found.push(`the restore generated ${have} ${what}, expected ${floors}`);
  if (
    t.generated.releases !== expected.tables.state_leases.rows ||
    t.releaseHash.digest("hex") !== expected.tables.state_leases.digest
  )
    found.push("release events differ from imported live leases");
  const got = digests(t);
  for (const table of TABLES) {
    const want = expected.tables[table];
    if (got[table].rows !== want.rows)
      found.push(
        `${table} has ${got[table].rows} rows besides the generated floor, the source had ${want.rows}`,
      );
    else if (got[table].digest !== want.digest)
      found.push(`${table} holds the right row count but different content`);
  }
  return found;
}
