import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import { createStateClient } from "../../../src/assembly/state-client.ts";
import { StateOwner } from "../../../src/core/state/index.ts";
import type { SqlDatabase, SqlRow } from "../../../src/ports/store.ts";
import {
  historyReads,
  instrument,
  reads,
  writesKey,
} from "../../core/l5-state/numbered-fixture.ts";

setDefaultTimeout(30_000);

type Handler = (call: {
  input: Record<string, unknown>;
  config?: unknown;
  services: unknown;
}) => { id?: string; key?: string; commentId?: string };
type Aggregates = {
  count(prefix: string): number;
  maxNumber(prefix: string): number;
};
const namespace = "forge/work";
const actor = { kind: "agent" as const, id: "allocation" };
const globals = globalThis as Record<string, unknown>;
const hadFail = "fail" in globals;
const previousFail = globals.fail;
let operations: Record<string, Handler>;
beforeAll(() => {
  globals.fail = (code: string, message: string) => {
    throw new Error(`${code}: ${message}`);
  };
  operations = require(
    resolve(import.meta.dirname, "../../../src/blocks/work/entry.cts"),
  ) as typeof operations;
});
afterAll(() => {
  if (hadFail) globals.fail = previousFail;
  else delete globals.fail;
});

async function fixture() {
  const opened = await createSqliteStore(tmpdir()).open({
    path: ":memory:",
    readOnly: false,
  });
  if (!opened.ok) throw new Error(opened.unavailable.reason);
  const { db: real, log, hooks } = instrument(opened.handle.value);
  const decoded = { allocation: 0, point: 0 };
  // As in list-prefix.test.ts, count accesses to SQL row.body where JSON decoding happens.
  function counted(row: SqlRow, kind: keyof typeof decoded): SqlRow {
    if (!("body" in row)) return row;
    return {
      ...row,
      get body() {
        decoded[kind]++;
        return row.body!;
      },
    };
  }
  const db: SqlDatabase = {
    exec: (sql) => real.exec(sql),
    run: (sql, params) => real.run(sql, params),
    transaction: (body) => real.transaction(body),
    all: (sql, params) =>
      real.all(sql, params).map((row) => counted(row, "allocation")),
    get(sql, params) {
      const row = real.get(sql, params);
      return row === undefined ? undefined : counted(row, "point");
    },
  };
  const owner = new StateOwner(db, { now: () => 1000 });
  owner.initialize();
  const state = createStateClient({
    owner,
    namespace,
    context: { variant: "project", actor, project: { id: "allocation" } },
    write: true,
    requestId: "allocation",
  });
  return {
    owner,
    state,
    decoded,
    log,
    hooks,
    reset: () => {
      decoded.allocation = 0;
      decoded.point = 0;
    },
    seed: (
      entries: readonly { key: string; value: unknown }[],
      ns = namespace,
    ) =>
      owner.putMany(
        ns,
        entries.map((entry) => ({ ...entry, expectRevision: 0 })),
        actor,
      ),
    call: (
      op: string,
      input: Record<string, unknown>,
      view = state,
      config?: unknown,
    ) =>
      operations[`issue.${op}`]!({ input, services: { state: view }, config }),
    close: () => opened.handle.close(),
  };
}

function issue(n: number, prefix = "work") {
  return {
    key: `issue:work-${n}`,
    value: {
      id: `work-${n}`,
      prefix,
      title: `Record ${n}`,
      status: "open",
      labels: [],
      dependsOn: [],
      createdAt: new Date(1000).toISOString(),
    },
  };
}

test("issue.create allocates 1001 with zero allocation decodes among 1000 issues", async () => {
  const f = await fixture();
  try {
    f.seed(Array.from({ length: 1000 }, (_, n) => issue(n + 1)));
    f.reset();
    expect(f.call("create", { title: "Next" }).id).toBe("work-1001");
    expect(f.decoded.allocation).toBe(0);
    expect(f.decoded.point).toBeLessThanOrEqual(3);
  } finally {
    await f.close();
  }
});

for (const op of ["comment", "checkpoint", "link"] as const) {
  test(`issue.${op} allocates 501 with zero allocation decodes among 500 rows`, async () => {
    const f = await fixture();
    try {
      const prefix = `${op === "link" ? "link" : "comment"}:work-1:`;
      f.seed([issue(1)]);
      f.seed(
        Array.from({ length: 500 }, (_, n) => ({
          key: `${prefix}${n + 1}`,
          value: { id: "work-1", body: `Row ${n}` },
        })),
      );
      f.reset();
      const result = f.call(op, {
        id: "work-1",
        body: "Next",
        step: "build",
        branch: "topic",
        worktree: "fixture",
        next: "Check",
        relation: "delivers",
        url: "https://example.com/501",
      });
      expect(op === "link" ? result.key : result.commentId).toBe(
        `${prefix}501`,
      );
      expect(f.decoded.allocation).toBe(0);
      expect(f.decoded.point).toBeLessThanOrEqual(3);
    } finally {
      await f.close();
    }
  });
}

test("empty allocation prefixes still start at 1 for all four operations", async () => {
  const f = await fixture();
  try {
    expect(f.call("create", { title: "First" }).id).toBe("work-1");
    expect(f.call("comment", { id: "work-1", body: "First" }).commentId).toBe(
      "comment:work-1:1",
    );
    f.owner.delete(namespace, "comment:work-1:1", actor, { expectRevision: 1 });
    expect(
      f.call("checkpoint", {
        id: "work-1",
        step: "build",
        branch: "topic",
        worktree: "fixture",
        next: "Check",
      }).commentId,
    ).toBe("comment:work-1:1");
    expect(
      f.call("link", {
        id: "work-1",
        relation: "delivers",
        url: "https://example.com/1",
      }).key,
    ).toBe("link:work-1:1");
  } finally {
    await f.close();
  }
});

test("key aggregates match old JS allocation with gaps, aliases, literal prefixes and numeric ordering", async () => {
  const f = await fixture();
  try {
    f.seed([
      issue(2),
      issue(9),
      issue(10, "alpha"),
      {
        key: "issue:alpha-12",
        value: { ...issue(12).value, id: "alpha-12" },
      },
      ...[
        "comment:work-2:",
        "link:work-2:",
        "literal%_:",
        "literalXX:",
        "\u{10FFFF}",
      ].flatMap((prefix) =>
        [2, 9, 10].map((n) => ({
          key: `${prefix}${n}`,
          value: { body: `${n}` },
        })),
      ),
      { key: "literal%_:none", value: {} },
      { key: "literal%_:\u{10FFFF}child", value: {} },
      { key: "literal%_:\u{10FFFF}", value: {} },
    ]);
    f.seed([{ key: "issue:work-999", value: issue(999).value }], "forge/other");
    const records = f.owner.list(namespace);
    const oldMax = records
      .filter((row) => row.key.startsWith("issue:"))
      .reduce((max, record) => {
        const { id } = record.value as { id: string };
        return id.startsWith("work-")
          ? Math.max(max, Number(id.slice(5)) || 0)
          : max;
      }, 0);
    expect(oldMax).toBe(10);
    // These casts let the tests-only commit type-check while the new methods are absent on main.
    const owner = f.owner as StateOwner & {
      count(namespace: string, prefix: string): number;
      maxNumber(namespace: string, prefix: string): number;
    };
    const clients = [
      f.owner.client(namespace, actor),
      f.state,
    ] as unknown as Aggregates[];
    for (const prefix of [
      "",
      "issue:",
      "issue:work-",
      "comment:work-2:",
      "link:work-2:",
      "literal%_:",
      "\u{10FFFF}",
      "missing:",
    ]) {
      const rows = records.filter((row) => row.key.startsWith(prefix));
      const expectedMax = rows.reduce(
        (max, row) => Math.max(max, Number(/\d+$/.exec(row.key)?.[0] ?? 0)),
        0,
      );
      f.reset();
      expect(owner.count(namespace, prefix)).toBe(rows.length);
      expect(owner.maxNumber(namespace, prefix)).toBe(expectedMax);
      for (const client of clients) {
        expect(client.count(prefix)).toBe(rows.length);
        expect(client.maxNumber(prefix)).toBe(expectedMax);
      }
      expect(f.decoded).toEqual({ allocation: 0, point: 0 });
    }
    expect(owner.maxNumber(namespace, "issue:work-")).toBe(oldMax);
    for (const prefix of ["\ud800", "literal%_:\ud801"]) {
      expect(() => owner.count(namespace, prefix)).toThrow(
        "Aggregate prefix must be well-formed UTF-16 text",
      );
      expect(() => owner.maxNumber(namespace, prefix)).toThrow(
        "Aggregate prefix must be well-formed UTF-16 text",
      );
    }
    expect(f.call("create", { title: "Parity" }).id).toBe(`work-${oldMax + 1}`);
    for (const op of ["comment", "checkpoint", "link"]) {
      const result = f.call(op, {
        id: "work-2",
        body: "Gap",
        step: "build",
        branch: "topic",
        worktree: "fixture",
        next: "Check",
        relation: "delivers",
        url: "https://example.com/gap",
      });
      expect(op === "link" ? result.key : result.commentId).toBe(
        `${op === "link" ? "link" : "comment"}:work-2:${op === "checkpoint" ? 5 : 4}`,
      );
    }
    const absent = createStateClient({
      owner: undefined,
      namespace,
      context: { variant: "stateless" },
      write: false,
      requestId: "absent",
    }) as unknown as Aggregates;
    expect(absent.count("")).toBe(0);
    expect(absent.maxNumber("")).toBe(0);
  } finally {
    await f.close();
  }
});

for (const op of ["comment", "checkpoint", "link"]) {
  test(`a competing ${op} allocation still loses the create-if-absent revision guard`, async () => {
    const f = await fixture();
    try {
      f.seed([issue(1)]);
      const stale = {
        ...f.state,
        put: (
          key: string,
          value: unknown,
          options: { expectRevision: number },
        ) => {
          // Another caller commits after selection but before this caller's transaction.
          f.owner.put(namespace, key, value, actor, { expectRevision: 0 });
          return f.state.put(key, value, options);
        },
      };
      expect(() =>
        f.call(
          op,
          {
            title: "Race",
            id: "work-1",
            body: "Race",
            step: "build",
            branch: "topic",
            worktree: "fixture",
            next: "Check",
            relation: "delivers",
            url: "https://example.com/race",
          },
          stale,
        ),
      ).toThrow("Expected revision 0; current revision is 1");
      const key =
        op === "create"
          ? "issue:work-2"
          : `${op === "link" ? "link" : "comment"}:work-1:1`;
      expect(f.owner.get(namespace, key)?.revision).toBe(1);
    } finally {
      await f.close();
    }
  });
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const floorKey = "allocation:issue:work-";
const floor = (f: Fixture) => f.owner.get(namespace, floorKey)?.value;
const ids = (f: Fixture, op: string) =>
  (f.call(op, {}) as unknown as { items: { id: string }[] }).items.map(
    (item) => item.id,
  );
const remove = (f: Fixture, n: number, expectRevision = 1) =>
  f.owner.delete(namespace, `issue:work-${n}`, actor, { expectRevision });
/** A project from before the floor existed: live and deleted issue identities, no floor record. */
function legacy(f: Fixture, live: readonly number[], gone: readonly number[]) {
  f.seed([...live, ...gone].map((n) => issue(n)));
  for (const n of gone) remove(f, n);
}
/** Higher identities the allocation must ignore: other kinds, prefixes, namespaces and lease-only history. */
function noise(f: Fixture) {
  f.seed([
    { key: "comment:work-500:1", value: {} },
    { key: "link:work-500:1", value: {} },
    {
      key: "issue:alpha-600",
      value: { ...issue(600, "alpha").value, id: "alpha-600" },
    },
  ]);
  f.seed([{ key: "issue:work-700", value: issue(700).value }], "forge/other");
  f.owner.acquire(
    namespace,
    "issue:work-800",
    { actor, session: { id: "noise" } },
    100,
    "lease-800",
  );
}

for (const [name, live, gone, expected] of [
  ["an empty project", [], [], 1],
  ["live maximum with gaps", [2, 9, 10], [], 11],
  ["history only", [], [10], 11],
  ["a lower deletion", [10], [2], 11],
  ["a restored project", [1], [2], 3],
] as const)
  test(`create after ${name} allocates work-${expected} at revision 1 and commits that floor`, async () => {
    const f = await fixture();
    try {
      legacy(f, live, gone);
      noise(f);
      const created = f.call("create", { title: "Next" });
      expect(created.id).toBe(`work-${expected}`);
      expect(f.owner.get(namespace, `issue:work-${expected}`)?.revision).toBe(
        1,
      );
      expect(floor(f)).toEqual({ prefix: "issue:work-", number: expected });
      expect(ids(f, "ready")).toContain(`work-${expected}`);
      for (const n of gone) {
        expect(f.owner.get(namespace, `issue:work-${n}`)).toBeUndefined();
        expect(f.owner.events(namespace, `issue:work-${n}`)).toHaveLength(2);
      }
    } finally {
      await f.close();
    }
  }, 30_000);

test("a local create after the highest issue is deleted allocates the next unused number", async () => {
  const f = await fixture();
  try {
    expect(f.call("create", { title: "One" }).id).toBe("work-1");
    expect(f.call("create", { title: "Two" }).id).toBe("work-2");
    remove(f, 2);
    const history = f.owner.events(namespace, "issue:work-2");
    const receipts = f.owner.export().requests;
    expect(f.call("create", { title: "Three" }).id).toBe("work-3");
    expect(f.owner.get(namespace, "issue:work-3")?.revision).toBe(1);
    expect(floor(f)).toEqual({ prefix: "issue:work-", number: 3 });
    expect(f.owner.get(namespace, "issue:work-2")).toBeUndefined();
    expect(f.owner.events(namespace, "issue:work-2")).toEqual(history);
    expect(f.owner.export().requests).toEqual(receipts);
  } finally {
    await f.close();
  }
}, 30_000);

test("a missing floor is backfilled once, inside the lock, and later creates read no history", async () => {
  const f = await fixture();
  try {
    f.seed([issue(1), issue(2)]);
    f.owner.put(namespace, "issue:work-2", issue(2).value, actor, {
      expectRevision: 1,
    });
    remove(f, 2, 2);
    f.log.length = 0;
    expect(f.call("create", { title: "Three" }).id).toBe("work-3");
    const first = historyReads(f.log);
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((access) => access.locked)).toBe(true);
    f.log.length = 0;
    expect(f.call("create", { title: "Four" }).id).toBe("work-4");
    expect(historyReads(f.log)).toEqual([]);
    expect(floor(f)).toEqual({ prefix: "issue:work-", number: 4 });
  } finally {
    await f.close();
  }
}, 30_000);

test("backfill finds the true maximum in a history of more than a thousand events", async () => {
  const f = await fixture();
  try {
    const rows = Array.from({ length: 400 }, (_, n) => issue(n + 1));
    f.seed(rows);
    f.owner.putMany(
      namespace,
      rows.map((row) => ({ ...row, expectRevision: 1 })),
      actor,
    );
    for (let n = 1; n <= 400; n++) remove(f, n, 2);
    f.seed([issue(9000)]);
    remove(f, 9000);
    expect(f.owner.events(namespace).length).toBeGreaterThan(1200);
    expect(f.call("create", { title: "After" }).id).toBe("work-9001");
    f.log.length = 0;
    expect(f.call("create", { title: "Again" }).id).toBe("work-9002");
    expect(historyReads(f.log)).toEqual([]);
  } finally {
    await f.close();
  }
}, 60_000);

for (const withFloor of [true, false])
  test(`a peer deleting the highest issue before the lock cannot make its number reusable (${withFloor ? "with" : "without"} a floor)`, async () => {
    const f = await fixture();
    try {
      if (withFloor) {
        f.call("create", { title: "One" });
        f.call("create", { title: "Two" });
      } else legacy(f, [1, 2], []);
      f.hooks.entry = () => remove(f, 2);
      f.log.length = 0;
      expect(f.call("create", { title: "Three" }).id).toBe("work-3");
      expect(f.owner.get(namespace, "issue:work-2")).toBeUndefined();
      const allocation = reads(f.log).filter(
        (access) =>
          access.sql.includes("state_events") ||
          access.params.includes(floorKey),
      );
      expect(allocation.length).toBeGreaterThan(0);
      expect(allocation.every((access) => access.locked)).toBe(true);
    } finally {
      await f.close();
    }
  }, 30_000);

test("two overlapping creates get distinct consecutive numbers and one event each", async () => {
  const f = await fixture();
  try {
    f.seed([issue(1)]);
    // A peer create commits after this caller starts but before it takes the write lock.
    f.hooks.entry = () =>
      expect(f.call("create", { title: "Peer" }).id).toBe("work-2");
    expect(f.call("create", { title: "Mine" }).id).toBe("work-3");
    for (const n of [2, 3]) {
      expect(f.owner.get(namespace, `issue:work-${n}`)?.revision).toBe(1);
      expect(f.owner.events(namespace, `issue:work-${n}`)).toHaveLength(1);
    }
    expect(f.owner.events(namespace, floorKey).map((e) => e.data)).toEqual([
      { prefix: "issue:work-", number: 2 },
      { prefix: "issue:work-", number: 3 },
    ]);
  } finally {
    await f.close();
  }
}, 30_000);

for (const [name, table, key] of [
  ["floor record", "state_records", floorKey],
  ["floor event", "state_events", floorKey],
  ["issue record", "state_records", "issue:work-3"],
  ["issue event", "state_events", "issue:work-3"],
] as const)
  test(`a ${name} failure leaves no partial floor and the retry gets the same number`, async () => {
    const f = await fixture();
    try {
      legacy(f, [1], [2]);
      const before = f.owner.export();
      f.hooks.fail = (access) => writesKey(access, table, key);
      expect(() => f.call("create", { title: "Fault" })).toThrow(
        "injected write failure",
      );
      expect(f.owner.export()).toEqual(before);
      f.hooks.fail = undefined;
      expect(f.call("create", { title: "Retry" }).id).toBe("work-3");
      expect(floor(f)).toEqual({ prefix: "issue:work-", number: 3 });
    } finally {
      await f.close();
    }
  }, 30_000);

test("the floor never appears in issue reads and reads write nothing", async () => {
  const f = await fixture();
  try {
    const open = issue(2).value;
    f.seed([
      issue(1),
      { key: "issue:work-2", value: { ...open, dependsOn: ["work-1"] } },
      {
        key: "issue:work-3",
        value: { ...open, id: "work-3", status: "closed" },
      },
      issue(4),
      issue(5),
    ]);
    const holder = { actor, session: { id: "lease" } };
    f.owner.acquire(namespace, "issue:work-4", holder, 4_000_000_000_000, "l4");
    f.owner.acquire(namespace, "issue:work-5", holder, 10, "l5");
    expect(f.call("create", { title: "Six" }).id).toBe("work-6");
    expect(floor(f)).toEqual({ prefix: "issue:work-", number: 6 });
    const before = f.owner.export();
    expect(ids(f, "list")).toEqual([1, 2, 3, 4, 5, 6].map((n) => `work-${n}`));
    expect(ids(f, "ready")).toEqual(["work-1", "work-5", "work-6"]);
    expect(ids(f, "blocked")).toEqual(["work-2"]);
    expect(ids(f, "stale")).toEqual(["work-5"]);
    expect(() => f.call("show", { id: floorKey })).toThrow("INPUT_INVALID");
    expect(f.call("show", { id: "work-6" }).id).toBe("work-6");
    expect(f.owner.export()).toEqual(before);
  } finally {
    await f.close();
  }
}, 30_000);

test("a display prefix change keeps one stored sequence and one floor", async () => {
  const f = await fixture();
  try {
    expect(f.call("create", { title: "One" }).id).toBe("work-1");
    const second = f.call("create", { title: "Two" }, f.state, {
      idPrefix: "alpha",
    });
    expect(second.id).toBe("alpha-2");
    expect(f.owner.get(namespace, "issue:work-2")?.revision).toBe(1);
    expect(f.owner.list(namespace, "allocation:").map((r) => r.value)).toEqual([
      { prefix: "issue:work-", number: 2 },
    ]);
  } finally {
    await f.close();
  }
}, 30_000);

test("create refusals write no floor and keep their existing codes", async () => {
  const f = await fixture();
  try {
    const before = f.owner.export();
    for (const [input, code] of [
      [{ title: "Kind", kind: "mystery" }, "INPUT_INVALID"],
      [{ title: "Missing", dependsOn: ["work-999"] }, "NOT_FOUND"],
      [{ title: "Parent", parent: "work-999" }, "NOT_FOUND"],
      [{ title: "Malformed", dependsOn: ["absent"] }, "INPUT_INVALID"],
    ] as const)
      expect(() => f.call("create", input)).toThrow(code);
    expect(f.owner.export()).toEqual(before);
  } finally {
    await f.close();
  }
}, 30_000);
