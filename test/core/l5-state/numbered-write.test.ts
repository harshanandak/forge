import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import {
  StateOwner,
  type NumberedBuild,
} from "../../../src/core/state/index.ts";
import {
  historyReads,
  instrument,
  reads,
  writesKey,
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
  return {
    owner,
    log,
    hooks,
    next: (build?: (key: string, number: number) => NumberedBuild) =>
      owner.putNext(
        ns,
        prefix,
        build ?? ((key, number) => ({ value: { key, number } })),
        actor,
      ),
    floor: () => owner.get(ns, floorKey),
    /** Raw rows, readable even when a body is not valid JSON, so a refusal can prove it wrote nothing. */
    rows: () =>
      ["state_records", "state_events"].map((table) =>
        opened.handle.value.all(`SELECT * FROM ${table} ORDER BY 1,2,3`),
      ),
    forge: (body: string) =>
      opened.handle.value.run(
        "UPDATE state_records SET body=? WHERE namespace=? AND key=?",
        [body, ns, floorKey],
      ),
    put: (key: string, value: unknown = {}) =>
      owner.put(ns, key, value, actor, { expectRevision: 0 }),
    remove: (n: number, expectRevision = 1) =>
      owner.delete(ns, `item:x-${n}`, actor, { expectRevision }),
    close: () => opened.handle.close(),
  };
}
type Fixture = Awaited<ReturnType<typeof open>>;
const run = (body: (f: Fixture) => unknown) => async () => {
  const f = await open();
  try {
    await body(f);
  } finally {
    await f.close();
  }
};
const codeOf = (work: () => unknown) => {
  try {
    work();
  } catch (error) {
    return (error as { error?: { code?: string } }).error?.code;
  }
};

test(
  "a numbered write allocates above a deleted highest number and records the floor",
  run((f) => {
    expect(f.next().key).toBe("item:x-1");
    expect(f.next().key).toBe("item:x-2");
    f.remove(2);
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
  }),
  30000,
);

test(
  "a missing floor is backfilled once under the lock from live keys and all matching history",
  run((f) => {
    for (const n of [1, 9, 10, 2, 40]) f.put(`item:x-${n}`);
    f.owner.put(ns, "item:x-2", { v: 2 }, actor, { expectRevision: 1 });
    f.remove(2, 2);
    f.remove(40);
    // Ignored: lease-only history, other prefixes, nonnumeric suffixes, other namespaces.
    f.owner.acquire(
      ns,
      "item:x-99",
      { actor, session: { id: "s" } },
      100,
      "l99",
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
  }),
  30000,
);

test(
  "an empty prefix starts at 1 and a large history costs one floor read and one candidate probe",
  run((f) => {
    expect(f.next().key).toBe("item:x-1");
    for (let n = 2; n <= 200; n++) {
      f.next();
      f.remove(n);
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
  }),
  30000,
);

const stale = (key: string, number: number): NumberedBuild => ({
  value: { key, number },
  readSet: [{ key: "item:x-1", expectRevision: 7 }],
});
type Refusal = [string, (f: Fixture) => void, typeof stale | undefined, string];
type Wrapper = Record<string, unknown>;
// Each keeps a valid floor value: only the stored wrapper, its text or its size is wrong.
const forgeries: [string, (wrapper: Wrapper) => string][] = [
  [
    "a wrong namespace",
    (w) => JSON.stringify({ ...w, namespace: "forge/other" }),
  ],
  ["a wrong key", (w) => JSON.stringify({ ...w, key: "allocation:item:z-" })],
  ["a wrong revision", (w) => JSON.stringify({ ...w, revision: 99 })],
  ["text that is not JSON", () => "{not json"],
  ["a stored JSON null", () => "null"],
  ["text over the size cap", (w) => JSON.stringify(w) + " ".repeat(8192)],
];
const refusals: Refusal[] = [
  [
    "an occupied candidate",
    (f) => {
      f.next();
      f.put("item:x-2");
    },
    undefined,
    "INPUT_CONFLICT",
  ],
  [
    "a stale dependency read set",
    (f) => f.put("item:x-1"),
    stale,
    "REVISION_CONFLICT",
  ],
  ...forgeries.map(([name, body]): Refusal => [
    `a forged floor wrapper with ${name}`,
    (f) => {
      f.next();
      f.forge(body(f.floor() as unknown as Wrapper));
    },
    undefined,
    "INPUT_INVALID",
  ]),
  ...[
    "text",
    null,
    { prefix: "item:y-", number: 1 },
    { prefix, number: -1 },
    { prefix, number: 1.5 },
    { prefix, number: 2 ** 53 },
    { prefix, number: Number.MAX_SAFE_INTEGER },
    { prefix, number: 1, extra: true },
  ].map((value): Refusal => [
    `an invalid floor ${JSON.stringify(value)}`,
    (f) => f.put(floorKey, value),
    undefined,
    "INPUT_INVALID",
  ]),
];
for (const [name, setup, build, code] of refusals)
  test(
    `${name} is refused with ${code} and writes nothing, not even a floor`,
    run((f) => {
      setup(f);
      const before = f.rows();
      expect(codeOf(() => f.next(build))).toBe(code);
      expect(f.rows()).toEqual(before);
    }),
    30000,
  );

for (const legacy of [false, true])
  for (const [name, table, key] of [
    ["floor record", "state_records", floorKey],
    ["floor event", "state_events", floorKey],
    ["issue record", "state_records", "item:x-3"],
    ["issue event", "state_events", "item:x-3"],
  ] as const)
    test(
      `a ${name} failure rolls back the floor and issue, then the retry reuses the number (${legacy ? "legacy backfill" : "existing floor"})`,
      run((f) => {
        if (legacy) {
          f.put("item:x-1");
          f.put("item:x-2");
        } else {
          f.next();
          f.next();
        }
        f.remove(2);
        const before = f.owner.export();
        f.hooks.fail = (access) => writesKey(access, table, key);
        expect(() => f.next()).toThrow("injected write failure");
        expect(f.owner.export()).toEqual(before);
        f.hooks.fail = undefined;
        expect(f.next().key).toBe("item:x-3");
        expect(f.floor()?.value).toEqual({ prefix, number: 3 });
      }),
      30000,
    );

for (const withFloor of [true, false])
  test(
    `a peer deleting the highest identity before the lock cannot make its number reusable (${withFloor ? "with" : "without"} a floor)`,
    run((f) => {
      if (withFloor) {
        f.next();
        f.next();
      } else {
        f.put("item:x-1");
        f.put("item:x-2");
      }
      f.hooks.entry = () => f.remove(2);
      f.log.length = 0;
      expect(f.next().key).toBe("item:x-3");
      expect(f.owner.get(ns, "item:x-2")).toBeUndefined();
      const floorReads = reads(f.log).filter((a) =>
        a.params.includes(floorKey),
      );
      expect(floorReads.length).toBeGreaterThan(0);
      expect(
        [...floorReads, ...historyReads(f.log)].every((a) => a.locked),
      ).toBe(true);
    }),
    30000,
  );
