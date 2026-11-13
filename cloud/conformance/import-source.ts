// A synthetic local state backup for the tracker import converter (forge-1231), and independent plain SQL reads of it.
// Test code only: the converter never imports it, and nothing here is computed by the converter.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { StateOwner } from "../../src/core/state/index.ts";
import type { SqlDatabase, SqlRow } from "../../src/ports/store.ts";
import type { Table } from "../../tools/tracker-import.ts";

export const NOW = 1_800_000_000_000;
export const ISO = new Date(NOW).toISOString();
export const WORK = "forge/work";
export const ACTOR = { kind: "agent", id: "fixture" } as const;
export const HOLDER = { actor: ACTOR, session: { id: "session" } };
export const KEYS: Record<Table, string> = {
  state_records: "namespace, key",
  state_events: "sequence",
  state_leases: "namespace, subject",
  state_requests: "namespace, request_id",
  domain_cloud_requests: "request_id",
};
export const COLUMNS: Record<Table, string> = {
  state_records: "namespace, key, revision, body",
  state_events: "sequence, namespace, key, body",
  state_leases: "namespace, subject, generation, body",
  state_requests: "namespace, request_id, fingerprint, result",
  domain_cloud_requests: "request_id, fingerprint, outcome, result",
};
export type Row = Record<string, string | number>;
export const sha = (text: string | Uint8Array): string =>
  createHash("sha256").update(text).digest("hex");
export const sqlOf = (db: Database): SqlDatabase => ({
  exec: (sql) => void db.run(sql),
  run: (sql, params = []) => db.query(sql).run(...(params as never[])),
  all: (sql, params = []) =>
    db.query(sql).all(...(params as never[])) as SqlRow[],
  get: (sql, params = []) =>
    (db.query(sql).get(...(params as never[])) ?? undefined) as
      SqlRow | undefined,
  transaction: (body) => db.transaction(body)(),
});

export interface Shape {
  /** Write the four allocation floors, or leave the history to carry the numbers. */
  floors: boolean;
  /** work-3 depends on these ids; the default is the coherent graph. */
  deps?: string[];
  /** A raw SQL statement applied to the finished backup. */
  tamper?: string;
}
export const issue = (n: number, extra: object = {}) => ({
  id: `work-${n}`,
  prefix: "forge",
  title: `Issue ${n}`,
  status: "open",
  labels: [],
  dependsOn: [],
  createdAt: ISO,
  ...extra,
});

/** A local state store with interleaved namespaces, every tracker key family, deletions, a lease and a shared request id. */
export function backup(dir: string, shape: Shape, name = "source.db") {
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  const raw = new Database(path);
  const owner = new StateOwner(sqlOf(raw), { now: () => NOW });
  owner.initialize();
  const put = (ns: string, key: string, value: unknown, requestId?: string) =>
    owner.put(ns, key, value, ACTOR, {
      expectRevision: 0,
      ...(requestId === undefined ? {} : { requestId }),
    });
  put("forge/identity", "project", { name: "excluded" });
  put(
    WORK,
    "issue:work-1",
    issue(1, { title: 'Ünï "q" \\ € \u0001' }),
    "put-a",
  );
  put("forge/other", "issue:work-1", { other: true }, "put-a");
  put(WORK, "issue:work-2", issue(2));
  put(
    WORK,
    "issue:work-3",
    issue(3, { parent: "work-1", dependsOn: shape.deps ?? ["work-1"] }),
  );
  owner.delete(WORK, "issue:work-2", ACTOR, { expectRevision: 1 });
  put(WORK, "comment:work-1:1", { id: "work-1", body: "one" });
  put(WORK, "comment:work-1:4", { id: "work-1", body: "four" });
  owner.delete(WORK, "comment:work-1:4", ACTOR, { expectRevision: 1 });
  put(WORK, "comment:work-3:2", { id: "work-3", body: "two" });
  owner.delete(WORK, "comment:work-3:2", ACTOR, { expectRevision: 1 });
  put(WORK, "link:work-1:1", {
    id: "work-1",
    relation: "delivers",
    url: "https://example.com/1",
  });
  const subject = "lane:work-1:attempt-1";
  const lease = owner.acquire(WORK, subject, HOLDER, 100, "claim-lane");
  owner.put(WORK, subject, { attempt: 1 }, ACTOR, {
    expectRevision: 0,
    requestId: "put-lane",
    fence: { subject, holder: HOLDER, generation: lease.generation },
  });
  put("forge/other", "other:key", { x: 1 });
  if (shape.floors)
    for (const [prefix, number] of [
      ["issue:work-", 3],
      ["comment:work-1:", 4],
      ["comment:work-3:", 2],
      ["link:work-1:", 1],
    ] as const)
      put(WORK, `allocation:${prefix}`, { prefix, number });
  if (shape.tamper !== undefined) raw.run(shape.tamper);
  raw.close();
  return { path, digest: sha(readFileSync(path)) };
}

// Independent reads of the finished backup, in plain SQL.
export function read(path: string, table: Table, ns: string | null): Row[] {
  const db = new Database(path, { readonly: true });
  try {
    if (table === "domain_cloud_requests" && !tableExists(db, table)) return [];
    const where = ns === null ? "" : ` WHERE namespace = '${ns}'`;
    return db
      .query(
        `SELECT ${COLUMNS[table]} FROM ${table}${where} ORDER BY ${KEYS[table]}`,
      )
      .all() as Row[];
  } finally {
    db.close();
  }
}
export const tableExists = (db: Database, table: string): boolean =>
  db.query("SELECT 1 FROM sqlite_master WHERE name = ?").get(table) !== null;

export const mapped = (path: string): Row[] =>
  read(path, "state_events", WORK).map((row, i) => ({
    ...row,
    sequence: i + 1,
  }));
