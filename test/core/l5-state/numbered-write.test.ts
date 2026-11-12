import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import { StateOwner } from "../../../src/core/state/index.ts";
import {
  historyReads,
  instrument,
  reads,
  writesKey,
  type Built,
  type NumberedOwner,
} from "./numbered-fixture.ts";

const ns = "forge/test";
const actor = { kind: "agent" as const, id: "numbered" };
const prefix = "item:x-";
const floorKey = `allocation:${prefix}`;

async function open() {
  const opened = await createSqliteStore(tmpdir()).open({
    path: ":memory:",
    readOnly: false,
  });
  if (!opened.ok) throw new Error(opened.unavailable.reason);
  const { db, log, hooks } = instrument(opened.handle.value);
  const owner = new StateOwner(db, { now: () => 1000 });
  owner.initialize();
  const numbered = owner as unknown as NumberedOwner;
  return {
    owner,
    log,
    hooks,
    next: (build?: (key: string, number: number) => Built) =>
      numbered.putNext(
        ns,
        prefix,
        build ?? ((key, number) => ({ value: { key, number } })),
        actor,
      ),
    floor: () => owner.get(ns, floorKey),
    put: (key: string, value: unknown = {}) =>
      owner.put(ns, key, value, actor, { expectRevision: 0 }),
    close: () => opened.handle.close(),
  };
}
function codeOf(work: () => unknown): string | undefined {
  try {
    work();
  } catch (error) {
    return (error as { error?: { code?: string } }).error?.code;
  }
  return undefined;
}

test("a numbered write allocates above a deleted highest number and records the floor", async () => {
  const f = await open();
  try {
    expect(f.next().key).toBe("item:x-1");
    expect(f.next().key).toBe("item:x-2");
    f.owner.delete(ns, "item:x-2", actor, { expectRevision: 1 });
    const third = f.next();
    expect([third.key, third.revision]).toEqual(["item:x-3", 1]);
    expect(f.floor()?.value).toEqual({ prefix, number: 3 });
    expect(f.floor()?.revision).toBe(3);
    expect(f.owner.events(ns, floorKey).map((e) => e.revision)).toEqual([
      1, 2, 3,
    ]);
    expect(f.owner.events(ns, "item:x-3")).toHaveLength(1);
    expect(f.owner.list(ns, prefix).map((r) => r.key)).toEqual([
      "item:x-1",
      "item:x-3",
    ]);
    // Generic recreation still resumes a deleted key's revision sequence.
    expect(f.put("item:x-2").revision).toBe(3);
  } finally {
    await f.close();
  }
}, 30000);

test("a missing floor is backfilled once under the lock from live keys and all matching history", async () => {
  const f = await open();
  try {
    f.put("item:x-1");
    f.put("item:x-9");
    f.put("item:x-10");
    // Updated then deleted, and a high deleted identity that is no longer live.
    f.put("item:x-2");
    f.owner.put(ns, "item:x-2", { v: 2 }, actor, { expectRevision: 1 });
    f.owner.delete(ns, "item:x-2", actor, { expectRevision: 2 });
    f.put("item:x-40");
    f.owner.delete(ns, "item:x-40", actor, { expectRevision: 1 });
    // Ignored: lease-only history, other prefixes, nonnumeric suffixes and other namespaces.
    f.owner.acquire(
      ns,
      "item:x-99",
      { actor, session: { id: "s" } },
      100,
      "lease-99",
    );
    for (const key of ["comment:x-77:1", "item:y-60", "item:x-abc"]) f.put(key);
    f.owner.put("forge/other", "item:x-500", {}, actor, { expectRevision: 0 });
    f.log.length = 0;
    expect(f.next().key).toBe("item:x-41");
    const first = [...f.log];
    expect(historyReads(first).length).toBeGreaterThan(0);
    expect(reads(first).every((access) => access.locked)).toBe(true);
    expect(f.floor()?.value).toEqual({ prefix, number: 41 });
    f.log.length = 0;
    expect(f.next().key).toBe("item:x-42");
    expect(historyReads(f.log)).toEqual([]);
  } finally {
    await f.close();
  }
}, 30000);

test("an empty prefix starts at 1 and a large history costs one floor read and one candidate probe", async () => {
  const f = await open();
  try {
    expect(f.next().key).toBe("item:x-1");
    for (let n = 2; n <= 200; n++) {
      f.next();
      f.owner.delete(ns, `item:x-${n}`, actor, { expectRevision: 1 });
    }
    f.log.length = 0;
    expect(f.next().key).toBe("item:x-201");
    expect(historyReads(f.log)).toEqual([]);
    for (const access of reads(f.log)) {
      expect(access.op).toBe("get");
      expect(access.sql).toContain("namespace=? AND key=?");
      expect(access.sql).not.toContain("key>=");
    }
    const keys = reads(f.log).flatMap((access) => access.params.slice(1));
    expect(keys).toContain(floorKey);
    expect(keys).toContain("item:x-201");
  } finally {
    await f.close();
  }
}, 30000);

test("an occupied candidate is refused without a search or a floor reset", async () => {
  const f = await open();
  try {
    f.next();
    f.put("item:x-2");
    const before = f.owner.export();
    expect(codeOf(() => f.next())).toBe("INPUT_CONFLICT");
    expect(f.owner.export()).toEqual(before);
  } finally {
    await f.close();
  }
}, 30000);

test("an invalid stored floor is refused, never treated as absent or as zero", async () => {
  for (const value of [
    "text",
    null,
    { prefix: "item:y-", number: 1 },
    { prefix, number: -1 },
    { prefix, number: 1.5 },
    { prefix, number: 2 ** 53 },
    { prefix, number: Number.MAX_SAFE_INTEGER },
    { prefix, number: 1, extra: true },
  ]) {
    const f = await open();
    try {
      f.put(floorKey, value);
      const before = f.owner.export();
      expect(codeOf(() => f.next())).toBe("INPUT_INVALID");
      expect(f.owner.export()).toEqual(before);
    } finally {
      await f.close();
    }
  }
}, 30000);

test("a stale dependency read set fails the whole numbered write and leaves no floor", async () => {
  const f = await open();
  try {
    f.put("item:x-1");
    const before = f.owner.export();
    expect(
      codeOf(() =>
        f.next((key, number) => ({
          value: { key, number },
          readSet: [{ key: "item:x-1", expectRevision: 7 }],
        })),
      ),
    ).toBe("REVISION_CONFLICT");
    expect(f.owner.export()).toEqual(before);
  } finally {
    await f.close();
  }
}, 30000);

for (const legacy of [false, true])
  for (const [name, table, key] of [
    ["floor record", "state_records", floorKey],
    ["floor event", "state_events", floorKey],
    ["issue record", "state_records", "item:x-3"],
    ["issue event", "state_events", "item:x-3"],
  ] as const)
    test(`a ${name} failure rolls back the floor and issue, then the retry reuses the number (${legacy ? "legacy backfill" : "existing floor"})`, async () => {
      const f = await open();
      try {
        if (legacy) {
          f.put("item:x-1");
          f.put("item:x-2");
          f.owner.delete(ns, "item:x-2", actor, { expectRevision: 1 });
        } else {
          f.next();
          f.next();
          f.owner.delete(ns, "item:x-2", actor, { expectRevision: 1 });
        }
        const before = f.owner.export();
        f.hooks.fail = (access) => writesKey(access, table, key);
        expect(() => f.next()).toThrow("injected write failure");
        expect(f.owner.export()).toEqual(before);
        f.hooks.fail = undefined;
        expect(f.next().key).toBe("item:x-3");
        expect(f.floor()?.value).toEqual({ prefix, number: 3 });
      } finally {
        await f.close();
      }
    }, 30000);

test("a peer that deletes the highest identity before the lock cannot make its number reusable", async () => {
  for (const withFloor of [true, false]) {
    const f = await open();
    try {
      if (withFloor) {
        f.next();
        f.next();
      } else {
        f.put("item:x-1");
        f.put("item:x-2");
      }
      f.hooks.entry = () =>
        f.owner.delete(ns, "item:x-2", actor, { expectRevision: 1 });
      f.log.length = 0;
      expect(f.next().key).toBe("item:x-3");
      expect(f.owner.get(ns, "item:x-2")).toBeUndefined();
      expect(reads(f.log).length).toBeGreaterThan(0);
      expect(
        reads(f.log)
          .filter(
            (access) =>
              access.sql.includes("state_events") ||
              access.params.includes(floorKey),
          )
          .every((access) => access.locked),
      ).toBe(true);
    } finally {
      await f.close();
    }
  }
}, 30000);
