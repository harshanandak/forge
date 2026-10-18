import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import {
  StateOwner,
  RestoreConsistencyFailure,
} from "../../../src/core/state/index.ts";
import type { StateEvent } from "../../../src/generated/types.ts";

const ns = "forge/test";
const actor = { kind: "agent" as const, id: "writer" };
const holder = { actor, session: { id: "session" } };
async function open() {
  const result = await createSqliteStore(tmpdir()).open({
    path: ":memory:",
    readOnly: false,
  });
  if (!result.ok) throw new Error(result.unavailable.reason);
  let now = 1000;
  const owner = new StateOwner(result.handle.value, { now: () => now });
  owner.initialize();
  return {
    owner,
    db: result.handle.value,
    close: () => result.handle.close(),
    tick: () => {
      now += 200;
    },
  };
}
async function history() {
  const source = await open();
  source.owner.put(ns, "record", { value: 1 }, actor, {
    expectRevision: 0,
    requestId: "put",
  });
  const first = source.owner.acquire(ns, "subject", holder, 100, "acquire");
  const fence = { subject: "subject", holder, generation: first.generation };
  source.owner.renew(ns, fence, 100);
  source.tick();
  const second = source.owner.acquire(ns, "subject", holder, 100, "reacquire");
  source.owner.release(ns, { ...fence, generation: second.generation });
  return source;
}
const kinds = [
  "record.updated",
  "lease.acquired",
  "lease.renewed",
  "lease.reacquired",
  "lease.released",
];
for (const kind of kinds) {
  for (const location of ["envelope", "data"] as const) {
    for (const mutation of ["extra", "missing", "wrong-type"] as const) {
      test(`restore refuses ${mutation} ${location} key in ${kind}, target untouched`, async () => {
        const source = await history();
        const target = await open();
        try {
          const row = source.db
            .all("SELECT sequence,body FROM state_events")
            .find(
              (row) =>
                (JSON.parse(String(row.body)) as StateEvent).type ===
                `${ns}:${kind}@1`,
            )!;
          const event = JSON.parse(String(row.body)) as StateEvent;
          const payload: Record<string, unknown> =
            location === "envelope"
              ? { ...event }
              : { ...(event.data as Record<string, unknown>) };
          const field =
            location === "envelope"
              ? "revision"
              : kind === "record.updated"
                ? "value"
                : kind === "lease.acquired" || kind === "lease.reacquired"
                  ? "previous"
                  : "generation";
          if (mutation === "extra") payload.injected = true;
          else if (mutation === "missing") delete payload[field];
          else payload[field] = [payload[field]];
          const damaged =
            location === "envelope" ? payload : { ...event, data: payload };
          source.db.run("UPDATE state_events SET body=? WHERE sequence=?", [
            JSON.stringify(damaged),
            row.sequence!,
          ]);
          const before = target.owner.export();
          expect(() => target.owner.restore(source.owner.export())).toThrow(
            RestoreConsistencyFailure,
          );
          expect(target.owner.export()).toEqual(before);
        } finally {
          await source.close();
          await target.close();
        }
      }, 30000);
    }
  }
}
test("all live event kinds and receipts round-trip through restore builders", async () => {
  const source = await history();
  const target = await open();
  const again = await open();
  try {
    const snapshot = source.owner.export();
    expect(snapshot.events.map((event) => event.type)).toEqual(
      kinds.map((kind) => `${ns}:${kind}@1`),
    );
    expect(snapshot.requests).toHaveLength(3);
    target.owner.restore(snapshot);
    expect(target.owner.events(ns)).toEqual(source.owner.events(ns));
    expect(target.owner.export().requests).toEqual(snapshot.requests);
    // A live lease makes restore itself emit a release, which must validate on the next restore.
    source.owner.acquire(ns, "live", holder, 100, "live");
    again.owner.restore(source.owner.export());
    const last = await open();
    try {
      last.owner.restore(again.owner.export());
      expect(last.owner.events(ns)).toEqual(again.owner.events(ns));
    } finally {
      await last.close();
    }
  } finally {
    await source.close();
    await target.close();
    await again.close();
  }
}, 30000);
