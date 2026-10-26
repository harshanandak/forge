import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import {
  StateOwner,
  RestoreConsistencyFailure,
} from "../../../src/core/state/index.ts";
import {
  baseline,
  eventKeyIndex,
  migrate,
  NewerStoreError,
} from "../../../src/core/state/migrations.ts";
import type {
  LeaseHolder,
  LeaseRecord,
  StateEvent,
} from "../../../src/generated/types.ts";

const ns = "forge/test";
const original: LeaseHolder = {
  actor: { kind: "human", id: "local-cli" },
  session: {
    id: "chat",
    device: "device-one",
    agent: "terminal",
    harness: "cli",
  },
};
const caller: LeaseHolder = {
  actor: { kind: "agent", id: "mcp-agent" },
  session: {
    id: "chat",
    device: "device-one",
    agent: "worker",
    harness: "codex",
  },
};
async function open(initialize = true) {
  const result = await createSqliteStore(tmpdir()).open({
    path: ":memory:",
    readOnly: false,
  });
  if (!result.ok) throw new Error(result.unavailable.reason);
  let now = 1000;
  const owner = new StateOwner(result.handle.value, { now: () => now });
  if (initialize) owner.initialize();
  return {
    owner,
    db: result.handle.value,
    close: () => result.handle.close(),
    tick: () => {
      now += 100;
    },
  };
}

test("qualified renew and release persist the caller labels and round-trip current and historical identities", async () => {
  const source = await open(),
    target = await open(),
    again = await open();
  try {
    const acquired = source.owner.acquire(
      ns,
      "subject",
      original,
      1000,
      "claim",
    );
    const fence = {
      subject: "subject",
      holder: caller,
      generation: acquired.generation,
    };
    source.owner.put(ns, "closed", true, caller.actor, {
      expectRevision: 0,
      requestId: "close",
      fence,
    });
    source.tick();
    const renewed = source.owner.renew(ns, fence, 2000);
    expect(renewed.holder).toEqual(caller);
    expect(renewed.generation).toBe(acquired.generation);
    expect(renewed.expiresAt).toBe(new Date(3100).toISOString());
    source.tick();
    const released = source.owner.release(ns, { ...fence, holder: original });
    expect(released.holder).toEqual(original);
    expect(released.expiresAt).toBe(renewed.expiresAt);
    expect(released.releasedAt).toBe(new Date(1200).toISOString());
    const events = source.owner.events(ns, "subject");
    expect(events.map((event) => event.actor)).toEqual([
      original.actor,
      caller.actor,
      original.actor,
    ]);
    expect((events[0]!.data as { lease: LeaseRecord }).lease.holder).toEqual(
      original,
    );
    expect((events[1]!.data as LeaseRecord).holder).toEqual(caller);
    target.owner.restore(source.owner.export());
    expect(target.owner.events(ns)).toEqual(source.owner.events(ns));
    expect(target.owner.lease(ns, "subject")).toEqual(released);
    again.owner.restore(target.owner.export());
    expect(again.owner.events(ns)).toEqual(source.owner.events(ns));
    expect(again.owner.export().requests).toEqual(
      source.owner.export().requests,
    );
  } finally {
    await source.close();
    await target.close();
    await again.close();
  }
}, 30000);

for (const operation of ["renew", "release", "close"] as const) {
  test(`legacy ${operation} accepts the matching actor and session with a device, then fences qualified rewrites`, async () => {
    const source = await open(),
      target = await open();
    try {
      const legacy = { actor: original.actor, session: { id: "chat" } };
      const acquired = source.owner.acquire(
        ns,
        "subject",
        legacy,
        1000,
        "claim",
      );
      const fence = {
        subject: "subject",
        holder: original,
        generation: acquired.generation,
      };
      const apply = (holder: LeaseHolder) => {
        if (operation === "close")
          return source.owner.put(ns, "closed", true, holder.actor, {
            expectRevision: 0,
            fence: { ...fence, holder },
          });
        return operation === "renew"
          ? source.owner.renew(ns, { ...fence, holder }, 2000)
          : source.owner.release(ns, { ...fence, holder });
      };
      for (const wrong of [
        caller,
        { ...original, session: { ...original.session, id: "other" } },
      ]) {
        expect(() => apply(wrong)).toThrow();
        expect(source.owner.lease(ns, "subject")).toEqual(acquired);
        expect(source.owner.events(ns)).toHaveLength(1);
      }
      apply(original);
      if (operation === "close")
        expect(source.owner.get(ns, "closed")?.value).toBe(true);
      else {
        expect(source.owner.lease(ns, "subject")?.holder).toEqual(original);
        expect(() =>
          source.owner.renew(
            ns,
            { ...fence, holder: { ...original, session: { id: "chat" } } },
            2000,
          ),
        ).toThrow();
      }
      target.owner.restore(source.owner.export());
      expect(
        target.owner.events(ns).slice(0, source.owner.events(ns).length),
      ).toEqual([...source.owner.events(ns)]);
    } finally {
      await source.close();
      await target.close();
    }
  }, 30000);
}

for (const operation of ["renew", "release"] as const) {
  for (const changed of [
    "device",
    "session",
    "actor",
    "generation",
    "expiry",
    "release",
  ] as const) {
    test(`restore refuses a forged ${changed} in a caller-labelled ${operation} without changing the target`, async () => {
      const source = await open(),
        target = await open();
      try {
        source.owner.acquire(ns, "subject", original, 1000, "claim");
        const fence = { subject: "subject", holder: caller, generation: 1 };
        if (operation === "renew") source.owner.renew(ns, fence, 2000);
        else source.owner.release(ns, fence);
        const row = source.db
          .all("SELECT sequence,body FROM state_events")
          .at(-1)!;
        const event = JSON.parse(String(row.body)) as StateEvent;
        const lease = event.data as LeaseRecord;
        const modified: LeaseRecord =
          changed === "device"
            ? {
                ...lease,
                holder: {
                  ...lease.holder,
                  session: { ...lease.holder.session, device: "other" },
                },
              }
            : changed === "session"
              ? {
                  ...lease,
                  holder: {
                    ...lease.holder,
                    session: { ...lease.holder.session, id: "other" },
                  },
                }
              : changed === "generation"
                ? { ...lease, generation: 2 }
                : changed === "expiry"
                  ? { ...lease, expiresAt: new Date(1000).toISOString() }
                  : changed === "release"
                    ? { ...lease, releasedAt: new Date(999).toISOString() }
                    : lease;
        const forged = {
          ...event,
          data: modified,
          ...(changed === "actor" ? { actor: original.actor } : {}),
        };
        source.db.run("UPDATE state_events SET body=? WHERE sequence=?", [
          JSON.stringify(forged),
          row.sequence!,
        ]);
        source.db.run(
          "UPDATE state_leases SET body=?,generation=? WHERE namespace=? AND subject=?",
          [JSON.stringify(modified), modified.generation, ns, "subject"],
        );
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

test("recovery releases a live caller-labelled lease and its resulting history restores again", async () => {
  const source = await open(),
    target = await open(),
    again = await open();
  try {
    source.owner.acquire(ns, "subject", original, 1000, "claim");
    source.owner.renew(
      ns,
      { subject: "subject", holder: caller, generation: 1 },
      2000,
    );
    target.owner.restore(source.owner.export());
    expect(target.owner.lease(ns, "subject")?.holder).toEqual(caller);
    expect(target.owner.events(ns, "subject").at(-1)?.actor).toEqual(
      caller.actor,
    );
    expect(target.owner.lease(ns, "subject")?.releasedAt).toBe(
      new Date(1000).toISOString(),
    );
    again.owner.restore(target.owner.export());
    expect(again.owner.events(ns)).toEqual(target.owner.events(ns));
    expect(again.owner.export().requests).toEqual(
      source.owner.export().requests,
    );
  } finally {
    await source.close();
    await target.close();
    await again.close();
  }
}, 30000);

test("replay cannot replace a legacy actor while adding qualified holder metadata", async () => {
  const source = await open(),
    target = await open();
  try {
    source.owner.acquire(
      ns,
      "subject",
      { actor: original.actor, session: { id: "chat" } },
      1000,
      "claim",
    );
    source.owner.renew(
      ns,
      { subject: "subject", holder: original, generation: 1 },
      2000,
    );
    const row = source.db.all("SELECT sequence,body FROM state_events").at(-1)!;
    const event = JSON.parse(String(row.body)) as StateEvent;
    const lease = { ...(event.data as LeaseRecord), holder: caller };
    source.db.run("UPDATE state_events SET body=? WHERE sequence=?", [
      JSON.stringify({ ...event, actor: caller.actor, data: lease }),
      row.sequence!,
    ]);
    source.db.run(
      "UPDATE state_leases SET body=? WHERE namespace=? AND subject=?",
      [JSON.stringify(lease), ns, "subject"],
    );
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

test("a qualified store records a harmless version marker and older migration lists refuse it without writes", async () => {
  const source = await open(false);
  try {
    migrate(source.db, [baseline, eventKeyIndex]);
    const schema = source.db.all(
      "SELECT type,name,sql FROM sqlite_schema ORDER BY name",
    );
    source.owner.initialize();
    expect(
      source.db.all("SELECT type,name,sql FROM sqlite_schema ORDER BY name"),
    ).toEqual(schema);
    const ledger = source.db.all("SELECT id FROM state_migrations ORDER BY id");
    expect(ledger.map((row) => row.id)).toEqual([
      baseline.id,
      eventKeyIndex.id,
      "003_device_session_identity",
    ]);
    const before = source.db.get("SELECT total_changes() AS total")?.total;
    expect(() => migrate(source.db, [baseline, eventKeyIndex])).toThrow(
      NewerStoreError,
    );
    expect(source.db.get("SELECT total_changes() AS total")?.total).toBe(
      before,
    );
    expect(
      source.db.all("SELECT id FROM state_migrations ORDER BY id"),
    ).toEqual(ledger);
    migrate(source.db);
    source.owner.initialize();
  } finally {
    await source.close();
  }
}, 30000);
