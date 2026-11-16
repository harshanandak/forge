import { expect } from "bun:test";
import { tmpdir } from "node:os";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import { StateOwner } from "../../../src/core/state/index.ts";
import type { SqlDatabase } from "../../../src/ports/store.ts";
export const actor = { kind: "agent" as const, id: "retention" };
export const ns = "forge/test";
export async function fixture() {
  const result = await createSqliteStore(tmpdir()).open({
    path: ":memory:",
    readOnly: false,
  });
  if (!result.ok) throw new Error(result.unavailable.reason);
  const db = result.handle.value;
  const owner = new StateOwner(db, { now: () => 1000 });
  return { db, owner, close: () => result.handle.close() };
}
export function usage(db: SqlDatabase, table: string, columns: string[]) {
  const actual = db.get(
    `SELECT COUNT(*) AS rows, COALESCE(SUM(${columns.map((c) => `LENGTH(CAST(${c} AS BLOB))`).join(" + ")}),0) AS bytes FROM ${table}`,
  );
  expect(
    db.get("SELECT rows,bytes FROM state_usage WHERE table_name=?", [table]),
  ).toEqual(actual);
}
