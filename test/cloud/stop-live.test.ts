import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "bun:test";
import type { Tables } from "../../cloud/conformance/max-source.ts";
import type { StopDelta } from "../../cloud/conformance/restored.ts";

interface Observation {
  add(tables: Tables): void;
  delta(): StopDelta;
  floorClock(): string;
}
async function observationApi() {
  const module = new URL(
    "../../cloud/conformance/stop-live.ts",
    import.meta.url,
  );
  assert.ok(existsSync(module), "live stop observation API is present");
  return (await import(module.href)) as {
    stopObservation: (window: readonly [number, number]) => Observation;
    liveStops: () => {
      restored(project: string, window: readonly [number, number]): void;
      page(project: string, tables: Tables): void;
      get(project: string): StopDelta | undefined;
    };
  };
}

const at = "2027-01-15T08:00:00.000Z",
  time = Date.parse(at);
const incarnation = "11111111-1111-4111-8111-111111111111";
const auditId = "22222222-2222-4222-8222-222222222222";
const global = {
  namespace: "forge/work",
  key: "lane-control:global",
  body: JSON.stringify({ updatedAt: at, value: { incarnation } }),
};
const event = {
  sequence: 2,
  namespace: "forge/work",
  key: `lane-control:audit:${auditId}`,
  body: "{}",
};

test("live stop metadata crosses pages, freezes after consumption and resets on restore", async () => {
  const { liveStops } = await observationApi();
  const live = liveStops();
  live.restored("p", [time, time + 1]);
  live.page("p", { state_records: [global], state_events: [] });
  assert.throws(() => live.get("p"), /observed stop metadata/);
  live.page("p", { state_records: [], state_events: [event] });
  const delta = live.get("p");
  assert.deepEqual(delta, {
    at,
    incarnation,
    auditId,
    window: [time, time + 1],
  });
  live.page("p", {
    state_records: [],
    state_events: [{ ...event, key: "later-write" }],
  });
  assert.equal(live.get("p"), delta);
  live.restored("p", [time + 2, time + 3]);
  assert.throws(() => live.get("p"), /observed stop metadata/);
}, 1000);

test("floor observation accepts only a canonical ISO time inside the request", async () => {
  const { stopObservation } = await observationApi();
  for (const stamp of [at, "2027-01-15", "2027-01-15T08:00:00.002Z"]) {
    const observed = stopObservation([time, time + 1]);
    observed.add({
      state_records: [
        {
          namespace: "forge/work",
          key: "allocation:issue:work-",
          body: JSON.stringify({ updatedAt: stamp }),
        },
      ],
      state_events: [],
    });
    if (stamp === at) assert.equal(observed.floorClock(), at);
    else assert.throws(() => observed.floorClock(), /floor/);
  }
}, 1000);
