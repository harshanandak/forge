import assert from "node:assert/strict";
import { canonicalJson } from "../../src/core/config/pointer.ts";
import { suffixNumber } from "../../src/core/state/index.ts";
import type { Tables } from "./max-source.ts";
import { FLOOR, type Expected } from "./digest.ts";
import { stopPlan } from "./restored.ts";
import { stopObservation } from "./stop-live.ts";
type Row = Tables[string][number];
const isGlobal = (row: Row) =>
  row.namespace === "forge/work" && row.key === "lane-control:global";

/** Scan bounded input pages; retain at most the prior global, its history and the high-water row. */
export function capacityStop(
  pages: Iterable<{ tables: Tables }>,
  expected: Expected,
  observed: ReturnType<typeof stopObservation>,
) {
  const delta = observed.delta();
  let global: Row | undefined, history: Row | undefined, last: Row | undefined;
  let number = 0,
    revision = 0;
  for (const { tables } of pages) {
    for (const table of ["state_records", "state_events"])
      for (const row of tables[table]!) {
        assert.ok(
          row.namespace !== "forge/work" ||
            row.key !== `lane-control:audit:${delta.auditId}`,
          "stop audit key is fresh",
        );
        if (table === "state_records" && isGlobal(row)) global = row;
        if (row.namespace === FLOOR.namespace) {
          if (table === "state_events") {
            const event = JSON.parse(String(row.body)) as {
              type: string;
              revision: number;
              data: { number?: number };
            };
            if (
              !event.type.endsWith(":record.updated@1") &&
              !event.type.endsWith(":record.deleted@1")
            )
              continue;
            if (isGlobal(row)) history = row;
            if (row.key === FLOOR.key) {
              revision = event.revision;
              number = Math.max(number, event.data?.number ?? 0);
            }
            if (!event.type.endsWith(":record.deleted@1")) continue;
          }
          number = Math.max(
            number,
            suffixNumber(String(row.key), "issue:work-") ?? 0,
          );
        }
      }
    last = tables.state_events!.at(-1) ?? last;
  }
  const before: Tables = {
    state_records: global ? [global] : [],
    state_events:
      history && history !== last
        ? [history, ...(last ? [last] : [])]
        : last
          ? [last]
          : [],
  };
  let floor: readonly [Row, Row] | undefined;
  if (!expected.floorSupplied) {
    const at = observed.floorClock(),
      actor = { kind: "agent", id: "cloud-restore" };
    const value = { prefix: "issue:work-", number };
    floor = [
      {
        ...FLOOR,
        revision: revision + 1,
        body: canonicalJson({
          ...FLOOR,
          revision: revision + 1,
          value,
          updatedAt: at,
          updatedBy: actor,
        }),
      },
      {
        sequence: expected.lastSequence + 1,
        ...FLOOR,
        body: canonicalJson({
          type: "forge/work:record.updated@1",
          ...FLOOR,
          revision: revision + 1,
          at,
          actor,
          data: value,
        }),
      },
    ];
  }
  return stopPlan(
    before,
    delta,
    floor,
    Number(!expected.floorSupplied) + expected.tables.state_leases.rows,
  )!;
}
