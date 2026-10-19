import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import { StateOwner } from "../../../src/core/state/index.ts";
import type { SqlDatabase } from "../../../src/ports/store.ts";

const ns = "forge/test";
const actor = { kind: "agent" as const, id: "batch" };

async function open() {
  const result = await createSqliteStore(tmpdir()).open({
    path: ":memory:",
    readOnly: false,
  });
  if (!result.ok) throw new Error(result.unavailable.reason);
  const real = result.handle.value;
  const counted = { transactions: 0 };
  // The owner sees the store only through this port, so counting transactions here counts commits.
  const db: SqlDatabase = {
    exec: (sql) => real.exec(sql),
    run: (sql, params) => real.run(sql, params),
    get: (sql, params) => real.get(sql, params),
    all: (sql, params) => real.all(sql, params),
    transaction: (body) => {
      counted.transactions += 1;
      return real.transaction(body);
    },
  };
  const owner = new StateOwner(db, { now: () => 1000 });
  owner.initialize();
  return { owner, counted, close: () => result.handle.close() };
}

test("a batch of fifty records is one transaction; fifty single writes are fifty", async () => {
  const { owner, counted, close } = await open();
  try {
    const entries = Array.from({ length: 50 }, (_, index) => ({
      key: `batch/${index}`,
      value: { index },
      expectRevision: 0,
    }));
    counted.transactions = 0;
    const written = owner.putMany(ns, entries, actor);
    expect(counted.transactions).toBe(1);
    expect(written).toHaveLength(50);
    expect(written.every((record) => record.revision === 1)).toBe(true);
    expect(owner.list(ns, "batch/")).toHaveLength(50);
    expect(owner.events(ns)).toHaveLength(50);

    counted.transactions = 0;
    for (let index = 0; index < 50; index += 1)
      owner.put(ns, `single/${index}`, { index }, actor, { expectRevision: 0 });
    expect(counted.transactions).toBe(50);
  } finally {
    await close();
  }
}, 30_000);

test("a batch with one stale entry writes nothing, not even the entries before it", async () => {
  const { owner, close } = await open();
  try {
    owner.put(ns, "b/2", "taken", actor, { expectRevision: 0 });
    const events = owner.events(ns).length;
    expect(() =>
      owner.putMany(
        ns,
        [
          { key: "b/1", value: 1, expectRevision: 0 },
          { key: "b/2", value: 2, expectRevision: 0 },
          { key: "b/3", value: 3, expectRevision: 0 },
        ],
        actor,
      ),
    ).toThrow(/Expected revision 0/);
    expect(owner.get(ns, "b/1")).toBeUndefined();
    expect(owner.get(ns, "b/3")).toBeUndefined();
    expect(owner.get(ns, "b/2")?.value).toBe("taken");
    expect(owner.events(ns)).toHaveLength(events);
  } finally {
    await close();
  }
}, 30_000);

test("a batch refuses a repeated key and a bad expected revision before writing", async () => {
  const { owner, close } = await open();
  try {
    expect(() =>
      owner.putMany(
        ns,
        [
          { key: "k", value: 1, expectRevision: 0 },
          { key: "k", value: 2, expectRevision: 0 },
        ],
        actor,
      ),
    ).toThrow();
    expect(() =>
      owner.putMany(ns, [{ key: "k", value: 1, expectRevision: -1 }], actor),
    ).toThrow();
    expect(owner.list(ns)).toHaveLength(0);
  } finally {
    await close();
  }
}, 30_000);

test("a bound client batch-writes under its own namespace and actor", async () => {
  const { owner, close } = await open();
  try {
    const client = owner.client(ns, actor);
    client.putMany([
      { key: "a", value: 1, expectRevision: 0 },
      { key: "b", value: 2, expectRevision: 0 },
    ]);
    expect(client.list().map((record) => record.key)).toEqual(["a", "b"]);
    expect(client.get("a")?.updatedBy).toEqual(actor);
    expect(owner.list("forge/other")).toHaveLength(0);
  } finally {
    await close();
  }
}, 30_000);

test("listRange reads one bounded page of keys, in order or reverse, and refuses a bad limit", async () => {
  const { owner, close } = await open();
  try {
    owner.putMany(
      ns,
      Array.from({ length: 30 }, (_, index) => ({
        key: `r/${String(index).padStart(3, "0")}`,
        value: index,
        expectRevision: 0,
      })),
      actor,
    );
    owner.put("forge/other", "r/000", "elsewhere", actor, {
      expectRevision: 0,
    });
    const keys = (records: readonly { key: string }[]) =>
      records.map((record) => record.key);
    expect(keys(owner.listRange(ns, { from: "r/005", limit: 3 }))).toEqual([
      "r/005",
      "r/006",
      "r/007",
    ]);
    expect(
      keys(owner.listRange(ns, { to: "r/010", limit: 3, descending: true })),
    ).toEqual(["r/009", "r/008", "r/007"]);
    expect(
      owner.listRange(ns, { from: "r/", to: "r/\u{10FFFF}", limit: 1000 }),
    ).toHaveLength(30);
    // The namespace is part of the range: another block's records are never read.
    expect(owner.listRange(ns, { from: "r/000", limit: 1 })[0]?.value).toBe(0);
    for (const limit of [0, 1001, 1.5])
      expect(() => owner.listRange(ns, { limit })).toThrow();
    expect(keys(owner.list(ns, "r/02"))).toHaveLength(10);
  } finally {
    await close();
  }
}, 30_000);
