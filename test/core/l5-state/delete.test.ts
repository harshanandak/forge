import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import { createStateClient } from "../../../src/assembly/state-client.ts";
import {
  RestoreConsistencyFailure,
  StateOwner,
} from "../../../src/core/state/index.ts";
import type { BoundContext } from "../../../src/generated/types.ts";

const ns = "forge/test";
const actor = { kind: "agent" as const, id: "retire" };

async function open() {
  const result = await createSqliteStore(tmpdir()).open({
    path: ":memory:",
    readOnly: false,
  });
  if (!result.ok) throw new Error(result.unavailable.reason);
  const owner = new StateOwner(result.handle.value, { now: () => 1000 });
  owner.initialize();
  return { owner, db: result.handle.value, close: () => result.handle.close() };
}

test("delete removes only the active namespaced record and preserves monotonic history on recreation", async () => {
  const { owner, close } = await open();
  try {
    const client = owner.client(ns, actor);
    const first = client.put("key", "first", { expectRevision: 0 });
    owner.put("forge/other", "key", "other", actor, { expectRevision: 0 });
    const removed = client.delete("key", { expectRevision: first.revision });
    expect(removed).toEqual({
      type: `${ns}:record.deleted@1`,
      namespace: ns,
      key: "key",
      revision: 2,
      at: "1970-01-01T00:00:01.000Z",
      actor,
    });
    expect(client.get("key")).toBeUndefined();
    expect(client.list()).toEqual([]);
    expect(client.listRange({ limit: 1 })).toEqual([]);
    expect(owner.get("forge/other", "key")?.value).toBe("other");
    expect(client.history({ key: "key", limit: 5 })).toEqual([
      removed,
      client.events("key")[0]!,
    ]);
    const next = client.put("key", "next", { expectRevision: 0 });
    expect(next.revision).toBe(3);
    expect(() => client.put("key", "stale", { expectRevision: 1 })).toThrow();
    expect(() => client.delete("key", { expectRevision: 1 })).toThrow();
    client.delete("key", { expectRevision: 3 });
    expect(
      client.putMany([{ key: "key", value: "batch", expectRevision: 0 }])[0]
        ?.revision,
    ).toBe(5);
    expect(client.events("key").map((event) => event.revision)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  } finally {
    await close();
  }
}, 30000);

test("delete checks its revision and read set in one transaction before accepting an event", async () => {
  const { owner, db, close } = await open();
  try {
    owner.put(ns, "key", true, actor, { expectRevision: 0 });
    owner.put(ns, "dependency", true, actor, { expectRevision: 0 });
    owner.put(ns, "dependency", false, actor, { expectRevision: 1 });
    let locked = false;
    const observations: boolean[] = [];
    const guarded = new StateOwner(
      {
        ...db,
        get(sql, params) {
          if (sql.includes("FROM state_records")) observations.push(locked);
          return db.get(sql, params);
        },
        transaction<T>(work: () => T): T {
          return db.transaction(() => {
            locked = true;
            try {
              return work();
            } finally {
              locked = false;
            }
          });
        },
      },
      { now: () => 1000 },
    );
    const before = owner.export();
    expect(() =>
      guarded.delete(ns, "key", actor, {
        expectRevision: 1,
        readSet: [{ key: "dependency", expectRevision: 1 }],
      }),
    ).toThrow(/Read-set key dependency/);
    expect(observations.length).toBeGreaterThan(0);
    expect(observations.every(Boolean)).toBe(true);
    expect(owner.export()).toEqual(before);
    expect(() =>
      owner.delete(ns, "key", actor, { expectRevision: 0 }),
    ).toThrow();
    expect(() =>
      owner.delete(ns, "absent", actor, { expectRevision: 0 }),
    ).toThrow();
    expect(owner.export()).toEqual(before);
    guarded.delete(ns, "key", actor, {
      expectRevision: 1,
      readSet: [
        { key: "dependency", expectRevision: 2 },
        { key: "absent", expectRevision: 0 },
      ],
    });
    expect(owner.get(ns, "key")).toBeUndefined();
  } finally {
    await close();
  }
}, 30000);

test("delete rolls the record removal back when recording its event fails", async () => {
  const { owner, db, close } = await open();
  try {
    owner.put(ns, "key", true, actor, { expectRevision: 0 });
    const before = owner.export();
    const failing = new StateOwner(
      {
        ...db,
        run(sql, params) {
          if (sql.startsWith("INSERT INTO state_events"))
            throw new Error("event fault");
          return db.run(sql, params);
        },
      },
      { now: () => 1000 },
    );
    expect(() =>
      failing.delete(ns, "key", actor, { expectRevision: 1 }),
    ).toThrow("event fault");
    expect(owner.export()).toEqual(before);
  } finally {
    await close();
  }
}, 30000);

test("delete rechecks authority after another holder takes over at transaction entry", async () => {
  const { owner, db, close } = await open();
  try {
    owner.put(ns, "key", true, actor, { expectRevision: 0 });
    const holder = { actor, session: { id: "old" } };
    const lease = owner.acquire(ns, "subject", holder, 1000, "old-holder");
    const fence = { subject: "subject", holder, generation: lease.generation };
    let takenOver = false;
    const racing = new StateOwner(
      {
        ...db,
        transaction<T>(work: () => T): T {
          owner.release(ns, fence);
          owner.acquire(
            ns,
            "subject",
            { actor, session: { id: "new" } },
            1000,
            "new-holder",
          );
          takenOver = true;
          return db.transaction(work);
        },
      },
      { now: () => 1000 },
    );
    expect(() =>
      racing.delete(ns, "key", actor, { expectRevision: 1, fence }),
    ).toThrow();
    expect(takenOver).toBe(true);
    expect(owner.get(ns, "key")?.revision).toBe(1);
    expect(owner.events(ns, "key")).toHaveLength(1);
  } finally {
    await close();
  }
}, 30000);

test("a read-only database refuses deletion and retains the record and history", async () => {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "forge-delete-readonly-")),
  );
  try {
    const store = createSqliteStore(directory);
    const writable = await store.open({ path: "state.db", readOnly: false });
    if (!writable.ok) throw new Error(writable.unavailable.reason);
    try {
      const owner = new StateOwner(writable.handle.value, { now: () => 1000 });
      owner.initialize();
      owner.put(ns, "key", true, actor, { expectRevision: 0 });
    } finally {
      await writable.handle.close();
    }
    const readonly = await store.open({ path: "state.db", readOnly: true });
    if (!readonly.ok) throw new Error(readonly.unavailable.reason);
    try {
      const owner = new StateOwner(readonly.handle.value, { now: () => 1000 });
      expect(() =>
        owner.delete(ns, "key", actor, { expectRevision: 1 }),
      ).toThrow();
      expect(owner.get(ns, "key")?.revision).toBe(1);
      expect(owner.events(ns, "key")).toHaveLength(1);
    } finally {
      await readonly.handle.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30000);

test("the assembly refuses undeclared, stateless, acquiring and stale held deletion", async () => {
  const { owner, close } = await open();
  try {
    owner.put(ns, "key", true, actor, { expectRevision: 0 });
    const session = { id: "first" };
    const holder = { actor, session };
    const lease = owner.acquire(ns, "subject", holder, 1000, "claim");
    const held: BoundContext = {
      variant: "leased",
      actor,
      session,
      project: { id: "p" },
      leaseMode: "held",
      leaseGeneration: lease.generation,
    };
    const client = (context: BoundContext, write = true) =>
      createStateClient({
        owner,
        namespace: ns,
        context,
        write,
        requestId: "delete-call",
      });
    const options = { expectRevision: 1, subject: "subject" };
    const before = owner.export();
    expect(() => client(held, false).delete("key", options)).toThrow();
    expect(() =>
      client({ variant: "stateless" }).delete("key", options),
    ).toThrow();
    expect(() =>
      client({
        variant: "leased",
        actor,
        session,
        project: { id: "p" },
        leaseMode: "acquire",
      }).delete("key", options),
    ).toThrow();
    expect(() =>
      client({ ...held, leaseGeneration: lease.generation + 1 }).delete(
        "key",
        options,
      ),
    ).toThrow();
    expect(owner.export()).toEqual(before);
    expect(() =>
      client(held).delete("key", {
        ...options,
        readSet: [{ key: "dependency", expectRevision: 1 }],
      }),
    ).toThrow(/Read-set key dependency/);
    expect(client(held).delete("key", options).revision).toBe(2);
    owner.put(ns, "key", true, actor, { expectRevision: 0 });
    owner.release(ns, {
      subject: "subject",
      holder,
      generation: lease.generation,
    });
    owner.acquire(
      ns,
      "subject",
      { actor, session: { id: "second" } },
      1000,
      "reclaim",
    );
    expect(() =>
      client(held).delete("key", { ...options, expectRevision: 3 }),
    ).toThrow();
    expect(owner.get(ns, "key")?.revision).toBe(3);
  } finally {
    await close();
  }
}, 30000);

test("deleted records and recreated put receipts restore without reusing revisions", async () => {
  const source = await open();
  const target = await open();
  try {
    const { owner } = source;
    owner.put(ns, "key", "first", actor, {
      expectRevision: 0,
      requestId: "first",
    });
    owner.delete(ns, "key", actor, { expectRevision: 1 });
    const recreated = owner.put(ns, "key", "next", actor, {
      expectRevision: 0,
      requestId: "next",
    });
    owner.put(ns, "dependent", true, actor, {
      expectRevision: 0,
      requestId: "dependent",
      readSet: [{ key: "key", expectRevision: 3 }],
    });
    owner.delete(ns, "key", actor, { expectRevision: 3 });
    owner.put(ns, "absent-check", true, actor, {
      expectRevision: 0,
      requestId: "absent-check",
      readSet: [{ key: "key", expectRevision: 0 }],
    });
    target.owner.restore(owner.export());
    expect(target.owner.get(ns, "key")).toBeUndefined();
    expect(target.owner.events(ns)).toEqual(owner.events(ns));
    expect(
      target.owner.put(ns, "key", "next", actor, {
        expectRevision: 0,
        requestId: "next",
      }),
    ).toEqual(recreated);
    expect(target.owner.get(ns, "key")).toBeUndefined();
    expect(
      target.owner.put(ns, "key", "third", actor, { expectRevision: 0 })
        .revision,
    ).toBe(5);
  } finally {
    await source.close();
    await target.close();
  }
}, 30000);

test("restore refuses forged deletion histories without modifying its target", async () => {
  for (const corruption of [
    "revision",
    "missing-row",
    "duplicate-delete",
    "payload",
  ]) {
    const source = await open();
    const target = await open();
    try {
      source.owner.put(ns, "key", true, actor, { expectRevision: 0 });
      const deleted = source.owner.delete(ns, "key", actor, {
        expectRevision: 1,
      });
      if (corruption === "revision") {
        source.db.run("UPDATE state_events SET body=? WHERE sequence=2", [
          JSON.stringify({ ...deleted, revision: 3 }),
        ]);
      } else if (corruption === "missing-row") {
        source.owner.put(ns, "key", true, actor, { expectRevision: 0 });
        source.db.run("DELETE FROM state_records");
      } else if (corruption === "duplicate-delete") {
        source.db.run(
          "INSERT INTO state_events(namespace,key,body) VALUES (?,?,?)",
          [ns, "key", JSON.stringify({ ...deleted, revision: 3 })],
        );
      } else {
        source.db.run("UPDATE state_events SET body=? WHERE sequence=2", [
          JSON.stringify({ ...deleted, data: true }),
        ]);
      }
      const before = target.owner.export();
      expect(() => target.owner.restore(source.owner.export())).toThrow(
        RestoreConsistencyFailure,
      );
      expect(target.owner.export()).toEqual(before);
    } finally {
      await source.close();
      await target.close();
    }
  }
}, 30000);
