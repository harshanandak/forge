import type { Database } from "bun:sqlite";
import {
  expectedImage,
  restoreStopped,
} from "../../cloud/conformance/restored.ts";
import { tablesOf, type Tables } from "../../cloud/conformance/max-source.ts";
import type { SqlDatabase, SqlRow } from "../../src/ports/store.ts";
import { LaneControlStore } from "../../cloud/src/lane-control-store.ts";
import assert from "node:assert/strict";

const sqlOf = (db: Database): SqlDatabase => ({
  exec: (sql) => {
    db.exec(sql);
  },
  run: (sql, p = []) => db.query(sql).run(...p),
  all: (sql, p = []) => db.query(sql).all(...p) as SqlRow[],
  get: (sql, p = []) =>
    (db.query(sql).get(...p) ?? undefined) as SqlRow | undefined,
  transaction: (body) => db.transaction(body)(),
});
const image = (tables: Tables) => [
  { format: "forge-cloud-dump/2" as const, tables },
];

/** Verify every row before exposing the pre-stop view to existing floor/history assertions. */
export async function restoredTables(
  db: Database,
  source: Tables,
  project = "p",
  at = Date.now(),
): Promise<Tables> {
  await restoreStopped(image(source), sqlOf(db), project, [at, at]);
  const tables = tablesOf(db),
    audit = tables.state_events!.at(-1)!.key;
  const global = (row: Record<string, unknown>) =>
    row.namespace === "forge/work" && row.key === "lane-control:global";
  tables.state_records = tables.state_records!.flatMap((row) =>
    global(row)
      ? source.state_records!.filter(global)
      : row.namespace === "forge/work" && row.key === audit
        ? []
        : [row],
  );
  tables.state_events = tables.state_events!.slice(0, -2);
  return tables;
}

/** Exact generated image for inclusive row/byte boundary fixtures, using the shared replay factory. */
export async function stoppedTables(
  source: Tables,
  at: number,
): Promise<Tables> {
  const tables: Tables = Object.fromEntries(
    Object.keys(source).map((t) => [t, []]),
  );
  for await (const page of expectedImage(image(source), at, (owner) =>
    assert.ok(
      new LaneControlStore(owner, "p").stop(
        { all: true },
        "cloud-restore",
        "cloud-restore",
        new Date(at).toISOString(),
      ).ok,
    ),
  ))
    for (const [table, rows] of Object.entries(page.tables))
      tables[table]!.push(...rows);
  return tables;
}
