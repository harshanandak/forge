import assert from "node:assert/strict";
import type { Tables } from "./max-source.ts";
import { FLOOR } from "./digest.ts";
import { type StopDelta } from "./restored.ts";

type Row = Tables[string][number];
export const expectsStop = () => process.env.CLOUD_RESTORE_STOP === "1";
const isGlobal = (row: Row) =>
  row.namespace === "forge/work" && row.key === "lane-control:global";

/** Observe only the clock/identity inputs; expected bodies are rendered independently. */
export function stopObservation(window: readonly [number, number]) {
  let global: Row | undefined, last: Row | undefined, floor: Row | undefined;
  return {
    add(tables: Tables) {
      global = tables.state_records!.find(isGlobal) ?? global;
      floor =
        tables.state_records!.find(
          (r) => r.namespace === FLOOR.namespace && r.key === FLOOR.key,
        ) ?? floor;
      last = tables.state_events!.at(-1) ?? last;
    },
    delta(): StopDelta {
      assert.ok(global && last, "observed stop metadata");
      const record = JSON.parse(String(global.body)) as {
        updatedAt: string;
        value: { incarnation: string };
      };
      assert.ok(
        String(last.key).startsWith("lane-control:audit:"),
        "stop audit suffix",
      );
      return {
        at: record.updatedAt,
        incarnation: record.value.incarnation,
        auditId: String(last.key).slice("lane-control:audit:".length),
        window,
      };
    },
    floorClock() {
      assert.ok(floor, "generated floor metadata");
      const at = (JSON.parse(String(floor.body)) as { updatedAt: string })
        .updatedAt;
      assert.equal(new Date(at).toISOString(), at, "floor ISO clock");
      assert.ok(
        window[0] <= Date.parse(at) && Date.parse(at) <= window[1],
        "floor request window",
      );
      return at;
    },
  };
}

/** A completed restore owns one observation, frozen when its metadata is first consumed. */
export function liveStops() {
  const observations = new Map<string, ReturnType<typeof stopObservation>>();
  const deltas = new Map<string, StopDelta>();
  return {
    restored(project: string, window: readonly [number, number]) {
      observations.set(project, stopObservation(window));
      deltas.delete(project);
    },
    page(project: string, tables: Tables) {
      if (!deltas.has(project)) observations.get(project)?.add(tables);
    },
    observation(project: string) {
      const observed = observations.get(project);
      assert.ok(observed, "restore request observation");
      return observed;
    },
    get(project: string): StopDelta | undefined {
      let delta = deltas.get(project);
      if (!delta) {
        delta = this.observation(project).delta();
        deltas.set(project, delta);
      }
      return delta;
    },
  };
}
