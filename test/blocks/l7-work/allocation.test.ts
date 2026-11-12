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
    ...real,
    all: (sql, params) =>
      real.all(sql, params).map((row) => counted(row, "allocation")),
    get(sql, params) {
      const row = real.get(sql, params);
      return row === undefined ? undefined : counted(row, "point");
    },
  };
  // The clock only moves when a test expires a lease.
  const clock = { now: 1000 };
  const owner = new StateOwner(db, { now: () => clock.now });
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
    clock,
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
    // Replaced expectation: the old assertion reused the deleted number "comment:work-1:1".
    expect(
      f.call("checkpoint", {
        id: "work-1",
        step: "build",
        branch: "topic",
        worktree: "fixture",
        next: "Check",
      }).commentId,
    ).toBe("comment:work-1:2");
    expect(f.owner.get(namespace, "comment:work-1:1")).toBeUndefined();
    expect(f.owner.events(namespace, "comment:work-1:1")).toHaveLength(2);
    expect(
      f.call("link", {
        id: "work-1",
        relation: "delivers",
        url: "https://example.com/1",
      }).key,
    ).toBe("link:work-1:1");
    expect(f.owner.get(namespace, "allocation:comment:work-1:")?.value).toEqual(
      {
        prefix: "comment:work-1:",
        number: 2,
      },
    );
    expect(f.owner.get(namespace, "allocation:link:work-1:")?.value).toEqual({
      prefix: "link:work-1:",
      number: 1,
    });
  } finally {
    await f.close();
  }
}, 30_000);

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
      // Replaced expectation: count plus one chose 4 and 5 over the live suffixes 2, 9 and 10; the
      // next number is above the highest live suffix, and comments and checkpoints share one sequence.
      expect(op === "link" ? result.key : result.commentId).toBe(
        `${op === "link" ? "link" : "comment"}:work-2:${op === "checkpoint" ? 12 : 11}`,
      );
    }
    expect(f.owner.get(namespace, "allocation:comment:work-2:")?.value).toEqual(
      {
        prefix: "comment:work-2:",
        number: 12,
      },
    );
    expect(f.owner.get(namespace, "allocation:link:work-2:")?.value).toEqual({
      prefix: "link:work-2:",
      number: 11,
    });
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
}, 30_000);

// Replaced expectation: a peer used to commit through put at the selected key, and the caller lost
// the create-if-absent revision guard. A peer now commits through the numbered write before the
// caller's transaction, and both writes keep distinct consecutive numbers. The revision guard itself
// stays covered by the core numbered-write tests.
for (const op of ["comment", "checkpoint", "link"] as const)
  test(`a competing ${op} committed before the lock takes its own number and loses nothing`, async () => {
    const f = await fixture();
    try {
      f.seed([issue(1)]);
      const prefix = `${op === "link" ? "link" : "comment"}:work-1:`;
      f.hooks.entry = () =>
        f.owner.putNext(
          namespace,
          prefix,
          () => ({ value: { id: "work-1", body: "Peer" } }),
          actor,
        );
      const result = f.call(op, {
        title: "Race",
        id: "work-1",
        body: "Race",
        step: "build",
        branch: "topic",
        worktree: "fixture",
        next: "Check",
        relation: "delivers",
        url: "https://example.com/race",
      });
      expect(op === "link" ? result.key : result.commentId).toBe(`${prefix}2`);
      expect(f.owner.get(namespace, `${prefix}1`)?.value).toEqual({
        id: "work-1",
        body: "Peer",
      });
      for (const n of [1, 2]) {
        expect(f.owner.get(namespace, `${prefix}${n}`)?.revision).toBe(1);
        expect(f.owner.events(namespace, `${prefix}${n}`)).toHaveLength(1);
      }
      expect(
        f.owner.events(namespace, `allocation:${prefix}`).map((e) => e.data),
      ).toEqual([
        { prefix, number: 1 },
        { prefix, number: 2 },
      ]);
    } finally {
      await f.close();
    }
  }, 30_000);

type Fixture = Awaited<ReturnType<typeof fixture>>;
const run = (body: (f: Fixture) => unknown) => async () => {
  const f = await fixture();
  try {
    await body(f);
  } finally {
    await f.close();
  }
};
const floorKey = "allocation:issue:work-";
const floor = (f: Fixture) => f.owner.get(namespace, floorKey)?.value;
const at = (n: number) => ({ prefix: "issue:work-", number: n });
const create = (f: Fixture, title: string) => f.call("create", { title }).id;
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
  const holder = { actor, session: { id: "noise" } };
  f.owner.acquire(namespace, "issue:work-800", holder, 100, "lease-800");
}

for (const [name, live, gone, expected] of [
  ["an empty project", [], [], 1],
  ["live maximum with gaps", [2, 9, 10], [], 11],
  ["history only", [], [10], 11],
  ["a lower deletion", [10], [2], 11],
  ["a restored project", [1], [2], 3],
] as const)
  test(
    `create after ${name} allocates work-${expected} at revision 1 and commits that floor`,
    run((f) => {
      legacy(f, live, gone);
      noise(f);
      expect(create(f, "Next")).toBe(`work-${expected}`);
      expect(f.owner.get(namespace, `issue:work-${expected}`)?.revision).toBe(
        1,
      );
      expect(floor(f)).toEqual(at(expected));
      expect(ids(f, "ready")).toContain(`work-${expected}`);
      for (const n of gone) {
        expect(f.owner.get(namespace, `issue:work-${n}`)).toBeUndefined();
        expect(f.owner.events(namespace, `issue:work-${n}`)).toHaveLength(2);
      }
    }),
    30_000,
  );

test(
  "a local create after the highest issue is deleted allocates the next unused number",
  run((f) => {
    expect(create(f, "One")).toBe("work-1");
    expect(create(f, "Two")).toBe("work-2");
    remove(f, 2);
    const history = f.owner.events(namespace, "issue:work-2");
    const receipts = f.owner.export().requests;
    expect(create(f, "Three")).toBe("work-3");
    expect(f.owner.get(namespace, "issue:work-3")?.revision).toBe(1);
    expect(floor(f)).toEqual(at(3));
    expect(f.owner.get(namespace, "issue:work-2")).toBeUndefined();
    expect(f.owner.events(namespace, "issue:work-2")).toEqual(history);
    expect(f.owner.export().requests).toEqual(receipts);
  }),
  30_000,
);

test(
  "a missing floor is backfilled once, inside the lock, and later creates read no history",
  run((f) => {
    f.seed([issue(1), issue(2)]);
    const second = { expectRevision: 1 };
    f.owner.put(namespace, "issue:work-2", issue(2).value, actor, second);
    remove(f, 2, 2);
    f.log.length = 0;
    expect(create(f, "Three")).toBe("work-3");
    const first = historyReads(f.log);
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((access) => access.locked)).toBe(true);
    f.log.length = 0;
    expect(create(f, "Four")).toBe("work-4");
    expect(historyReads(f.log)).toEqual([]);
    expect(floor(f)).toEqual(at(4));
  }),
  30_000,
);

test(
  "backfill finds the true maximum in a history of more than a thousand events",
  run((f) => {
    const rows = Array.from({ length: 400 }, (_, n) => issue(n + 1));
    f.seed(rows);
    const again = rows.map((row) => ({ ...row, expectRevision: 1 }));
    f.owner.putMany(namespace, again, actor);
    for (let n = 1; n <= 400; n++) remove(f, n, 2);
    f.seed([issue(9000)]);
    remove(f, 9000);
    expect(f.owner.events(namespace).length).toBeGreaterThan(1200);
    expect(create(f, "After")).toBe("work-9001");
    f.log.length = 0;
    expect(create(f, "Again")).toBe("work-9002");
    expect(historyReads(f.log)).toEqual([]);
  }),
  60_000,
);

for (const withFloor of [true, false])
  test(
    `a peer deleting the highest issue before the lock cannot make its number reusable (${withFloor ? "with" : "without"} a floor)`,
    run((f) => {
      if (withFloor) {
        create(f, "One");
        create(f, "Two");
      } else legacy(f, [1, 2], []);
      f.hooks.entry = () => remove(f, 2);
      f.log.length = 0;
      expect(create(f, "Three")).toBe("work-3");
      expect(f.owner.get(namespace, "issue:work-2")).toBeUndefined();
      const floorReads = reads(f.log).filter((a) =>
        a.params.includes(floorKey),
      );
      expect(floorReads.length).toBeGreaterThan(0);
      expect(
        [...floorReads, ...historyReads(f.log)].every((a) => a.locked),
      ).toBe(true);
    }),
    30_000,
  );

test(
  "two overlapping creates get distinct consecutive numbers and one event each",
  run((f) => {
    f.seed([issue(1)]);
    // A peer create commits after this caller starts but before it takes the write lock.
    f.hooks.entry = () => expect(create(f, "Peer")).toBe("work-2");
    expect(create(f, "Mine")).toBe("work-3");
    for (const n of [2, 3]) {
      expect(f.owner.get(namespace, `issue:work-${n}`)?.revision).toBe(1);
      expect(f.owner.events(namespace, `issue:work-${n}`)).toHaveLength(1);
    }
    expect(f.owner.events(namespace, floorKey).map((e) => e.data)).toEqual([
      at(2),
      at(3),
    ]);
  }),
  30_000,
);

// The four write points and both floor states are covered once, in the core numbered-write tests.
test(
  "a create whose floor event fails through the work block leaves nothing and the retry gets the same number",
  run((f) => {
    legacy(f, [1], [2]);
    const before = f.owner.export();
    f.hooks.fail = (access) => writesKey(access, "state_events", floorKey);
    expect(() => create(f, "Fault")).toThrow("injected write failure");
    expect(f.owner.export()).toEqual(before);
    f.hooks.fail = undefined;
    expect(create(f, "Retry")).toBe("work-3");
    expect(floor(f)).toEqual(at(3));
  }),
  30_000,
);

test(
  "the floor never appears in issue reads and reads write nothing",
  run((f) => {
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
    expect(create(f, "Six")).toBe("work-6");
    expect(floor(f)).toEqual(at(6));
    const before = f.owner.export();
    expect(ids(f, "list")).toEqual([1, 2, 3, 4, 5, 6].map((n) => `work-${n}`));
    expect(ids(f, "ready")).toEqual(["work-1", "work-5", "work-6"]);
    expect(ids(f, "blocked")).toEqual(["work-2"]);
    expect(ids(f, "stale")).toEqual(["work-5"]);
    expect(() => f.call("show", { id: floorKey })).toThrow("INPUT_INVALID");
    expect(f.call("show", { id: "work-6" }).id).toBe("work-6");
    expect(f.owner.export()).toEqual(before);
  }),
  30_000,
);

test(
  "a display prefix change keeps one stored sequence and one floor",
  run((f) => {
    expect(create(f, "One")).toBe("work-1");
    const alpha = { idPrefix: "alpha" };
    expect(f.call("create", { title: "Two" }, f.state, alpha).id).toBe(
      "alpha-2",
    );
    expect(f.owner.get(namespace, "issue:work-2")?.revision).toBe(1);
    const floors = f.owner.list(namespace, "allocation:");
    expect(floors.map((r) => r.value)).toEqual([at(2)]);
  }),
  30_000,
);

test(
  "create refusals write no floor and keep their existing codes",
  run((f) => {
    const before = f.owner.export();
    for (const [input, code] of [
      [{ title: "Kind", kind: "mystery" }, "INPUT_INVALID"],
      [{ title: "Missing", dependsOn: ["work-999"] }, "NOT_FOUND"],
      [{ title: "Parent", parent: "work-999" }, "NOT_FOUND"],
      [{ title: "Malformed", dependsOn: ["absent"] }, "INPUT_INVALID"],
    ] as const)
      expect(() => f.call("create", input)).toThrow(code);
    expect(f.owner.export()).toEqual(before);
  }),
  30_000,
);

// ---- forge-1306: comment and link numbers are never reused after a delete ----
type Kind = "comment" | "link";
type Writer = "comment" | "checkpoint" | "call" | "link";
const prefixOf = (kind: Kind, id = "work-1") => `${kind}:${id}:`;
const floorAt = (kind: Kind, id: string, number: number) => ({
  prefix: prefixOf(kind, id),
  number,
});
const floorOf = (f: Fixture, kind: Kind, id = "work-1") =>
  f.owner.get(namespace, `allocation:${prefixOf(kind, id)}`)?.value;
const floorEvents = (f: Fixture, kind: Kind, id = "work-1") =>
  f.owner.events(namespace, `allocation:${prefixOf(kind, id)}`);
const child = (kind: Kind, id: string, n: number) => ({
  key: `${prefixOf(kind, id)}${n}`,
  value:
    kind === "link"
      ? { id, relation: "delivers", url: `https://example.com/${n}` }
      : { id, body: `Comment ${n}` },
});
/** A project from before the floor existed: live and deleted children, deleted through the owner. */
function past(
  f: Fixture,
  kind: Kind,
  live: readonly number[],
  gone: readonly number[],
  id = "work-1",
) {
  f.seed([...live, ...gone].map((n) => child(kind, id, n)));
  for (const n of gone)
    f.owner.delete(namespace, `${prefixOf(kind, id)}${n}`, actor, {
      expectRevision: 1,
    });
}
const inputs = {
  comment: { body: "Next" },
  checkpoint: {
    step: "build",
    branch: "topic",
    worktree: "fixture",
    next: "Check",
  },
  call: { role: "build" },
  link: { relation: "delivers", url: "https://example.com/next" },
};
/** One append through the real handler; the answer is the new key. */
function add(
  f: Fixture,
  op: Writer,
  view = f.state,
  id = "work-1",
  config?: unknown,
) {
  const result = f.call(op, { id, ...inputs[op] }, view, config);
  return (op === "link" ? result.key : result.commentId)!;
}
const codeOf = (work: () => unknown) => {
  try {
    work();
  } catch (error) {
    return (error as { error?: { code?: string } }).error?.code;
  }
};
let leases = 0;
/** The issue lease for the link tests, held by one holder. */
const lend = (f: Fixture) =>
  f.owner.acquire(
    namespace,
    "issue:work-1",
    { actor, session: { id: "holder" } },
    600,
    `lend-${++leases}`,
  );
function held(f: Fixture, lease: { generation: number }, session = "holder") {
  return createStateClient({
    owner: f.owner,
    namespace,
    context: {
      variant: "leased",
      actor,
      session: { id: session },
      project: { id: "allocation" },
      leaseMode: "held",
      leaseGeneration: lease.generation,
    },
    write: true,
    requestId: `held-${session}-${lease.generation}`,
  });
}
/** Everything an append must leave alone, except that the floor gains exactly one event. */
function snapshot(
  f: Fixture,
  kind: Kind,
  live: readonly number[],
  gone: readonly number[],
) {
  const at = (n: number) => `${prefixOf(kind)}${n}`;
  return {
    issue: f.owner.get(namespace, "issue:work-1"),
    lease: f.owner.lease(namespace, "issue:work-1"),
    ready: ids(f, "ready"),
    blocked: ids(f, "blocked"),
    survivors: live.map((n) => f.owner.get(namespace, at(n))),
    deleted: gone.map((n) => [
      f.owner.get(namespace, at(n)),
      f.owner.events(namespace, at(n)),
    ]),
    floorEvents: floorEvents(f, kind).length,
  };
}
function expectAdded(
  f: Fixture,
  kind: Kind,
  key: string,
  expected: number,
  before: ReturnType<typeof snapshot>,
  live: readonly number[],
  gone: readonly number[],
) {
  expect(key).toBe(`${prefixOf(kind)}${expected}`);
  expect(f.owner.get(namespace, key)?.revision).toBe(1);
  expect(f.owner.events(namespace, key)).toHaveLength(1);
  expect(floorOf(f, kind)).toEqual(floorAt(kind, "work-1", expected));
  expect(floorEvents(f, kind).at(-1)?.data).toEqual(
    floorAt(kind, "work-1", expected),
  );
  const after = snapshot(f, kind, live, gone);
  expect({ ...after, floorEvents: after.floorEvents - 1 }).toEqual(before);
}

for (const op of ["comment", "checkpoint", "call"] as const) {
  for (const [name, live, gone, expected] of [
    ["the highest comment deleted", [1], [2], 3],
    ["every comment deleted", [], [1, 2], 3],
    ["a deleted suffix past 9", [9], [10], 11],
    ["sparse live suffixes", [1, 3], [], 4],
  ] as const)
    test(
      `issue.${op} after ${name} appends comment suffix ${expected} and advances only the floor`,
      run((f) => {
        f.seed([issue(1)]);
        past(f, "comment", live, gone);
        noise(f);
        const before = snapshot(f, "comment", live, gone);
        expectAdded(f, "comment", add(f, op), expected, before, live, gone);
      }),
      30_000,
    );
  test(
    `issue.${op} after a floor exists and the highest comment is deleted appends above it`,
    run((f) => {
      f.seed([issue(1)]);
      past(f, "comment", [1], []);
      expect(add(f, "comment")).toBe("comment:work-1:2");
      f.owner.delete(namespace, "comment:work-1:2", actor, {
        expectRevision: 1,
      });
      const before = snapshot(f, "comment", [1], [2]);
      expectAdded(f, "comment", add(f, op), 3, before, [1], [2]);
    }),
    30_000,
  );
}

for (const [name, live, gone, expected] of [
  ["the highest link deleted", [1], [2], 3],
  ["every link deleted", [], [1, 2], 3],
  ["a deleted suffix past 9", [9], [10], 11],
  ["sparse live suffixes 1 and 3", [1, 3], [], 4],
] as const)
  test(
    `issue.link after ${name} appends suffix ${expected} under the held lease`,
    run((f) => {
      f.seed([issue(1)]);
      past(f, "link", live, gone);
      noise(f);
      const lease = lend(f);
      const before = snapshot(f, "link", live, gone);
      const key = add(f, "link", held(f, lease));
      expectAdded(f, "link", key, expected, before, live, gone);
      expect(f.owner.get(namespace, key)?.value).toEqual({
        id: "work-1",
        ...inputs.link,
      });
    }),
    30_000,
  );
test(
  "issue.link after a floor exists and the highest link is deleted appends above it",
  run((f) => {
    f.seed([issue(1)]);
    past(f, "link", [1], []);
    const view = held(f, lend(f));
    expect(add(f, "link", view)).toBe("link:work-1:2");
    f.owner.delete(namespace, "link:work-1:2", actor, { expectRevision: 1 });
    const before = snapshot(f, "link", [1], [2]);
    expectAdded(f, "link", add(f, "link", view), 3, before, [1], [2]);
  }),
  30_000,
);

for (const kind of ["comment", "link"] as const)
  test(
    `two ${kind} adds racing for the lock get unique consecutive numbers above deleted history`,
    run((f) => {
      f.seed([issue(1)]);
      past(f, kind, [1], [2]);
      const prefix = prefixOf(kind);
      const lease = lend(f);
      const mine = kind === "link" ? held(f, lease) : f.state;
      const peer =
        kind === "link"
          ? held(f, lease)
          : createStateClient({
              owner: f.owner,
              namespace,
              context: {
                variant: "project",
                actor: { kind: "agent", id: "peer" },
                project: { id: "allocation" },
              },
              write: true,
              requestId: "peer",
            });
      // The peer commits after this caller started but before it takes the write lock.
      f.hooks.entry = () => expect(add(f, kind, peer)).toBe(`${prefix}3`);
      expect(add(f, kind, mine)).toBe(`${prefix}4`);
      for (const n of [3, 4]) {
        expect(f.owner.get(namespace, `${prefix}${n}`)?.revision).toBe(1);
        expect(f.owner.events(namespace, `${prefix}${n}`)).toHaveLength(1);
      }
      expect(floorEvents(f, kind).map((e) => e.data)).toEqual([
        floorAt(kind, "work-1", 3),
        floorAt(kind, "work-1", 4),
      ]);
      expect(f.owner.events(namespace, `${prefix}2`)).toHaveLength(2);
    }),
    30_000,
  );

for (const kind of ["comment", "link"] as const)
  for (const [name, floor, code] of [
    ["a malformed floor", -1, "INPUT_INVALID"],
    ["an exhausted number", Number.MAX_SAFE_INTEGER, "INPUT_INVALID"],
    ["an occupied candidate", 1, "INPUT_CONFLICT"],
  ] as const)
    test(
      `${name} refuses a ${kind} add with ${code}, changes nothing, and the repaired retry numbers above history`,
      run((f) => {
        f.seed([issue(1)]);
        past(f, kind, [1, 2], []);
        const prefix = prefixOf(kind);
        const floorKey = `allocation:${prefix}`;
        f.owner.put(namespace, floorKey, { prefix, number: floor }, actor, {
          expectRevision: 0,
        });
        const view = kind === "link" ? held(f, lend(f)) : f.state;
        const before = f.owner.export();
        expect(codeOf(() => add(f, kind, view))).toBe(code);
        expect(f.owner.export()).toEqual(before);
        f.owner.put(namespace, floorKey, { prefix, number: 2 }, actor, {
          expectRevision: 1,
        });
        expect(add(f, kind, view)).toBe(`${prefix}3`);
        expect(floorOf(f, kind)).toEqual(floorAt(kind, "work-1", 3));
      }),
      30_000,
    );

for (const [name, arrange] of [
  [
    "a foreign holder",
    (f: Fixture) => {
      const lease = lend(f);
      return { refused: held(f, lease, "intruder"), repaired: () => lease };
    },
  ],
  [
    "an expired lease",
    (f: Fixture) => {
      const lease = lend(f);
      f.clock.now += 10_000;
      return { refused: held(f, lease), repaired: () => lend(f) };
    },
  ],
] as const)
  test(
    `a link add under ${name} refuses, burns no number, and the holder retry gets the next suffix`,
    run((f) => {
      f.seed([issue(1)]);
      past(f, "link", [1], [2]);
      const { refused, repaired } = arrange(f);
      const before = f.owner.export();
      expect(() => add(f, "link", refused)).toThrow();
      expect(f.owner.export()).toEqual(before);
      expect(add(f, "link", held(f, repaired()))).toBe("link:work-1:3");
      expect(floorOf(f, "link")).toEqual(floorAt("link", "work-1", 3));
    }),
    30_000,
  );

test(
  "numbers are independent per stored issue, kind and namespace, and display aliases share one sequence",
  run((f) => {
    f.seed([issue(1), issue(2)]);
    f.seed([child("comment", "work-1", 50)], "forge/other");
    past(f, "comment", [1], [2], "work-1");
    past(f, "comment", [], [3], "work-2");
    past(f, "link", [], [7], "work-1");
    const other = f.owner.list("forge/other");
    expect(add(f, "comment")).toBe("comment:work-1:3");
    expect(add(f, "comment", f.state, "alpha-1", { idPrefix: "alpha" })).toBe(
      "comment:work-1:4",
    );
    expect(add(f, "comment", f.state, "work-2")).toBe("comment:work-2:4");
    expect(add(f, "link")).toBe("link:work-1:8");
    expect(
      f.owner.list(namespace, "allocation:").map((row) => [row.key, row.value]),
    ).toEqual([
      ["allocation:comment:work-1:", floorAt("comment", "work-1", 4)],
      ["allocation:comment:work-2:", floorAt("comment", "work-2", 4)],
      ["allocation:link:work-1:", floorAt("link", "work-1", 8)],
    ]);
    expect(f.owner.list("forge/other")).toEqual(other);
  }),
  30_000,
);

test(
  "with a floor present, an add reads no history and decodes no allocation bodies",
  run((f) => {
    f.seed([issue(1)]);
    f.seed(
      Array.from({ length: 500 }, (_, n) => child("comment", "work-1", n + 1)),
    );
    expect(add(f, "comment")).toBe("comment:work-1:501");
    f.log.length = 0;
    f.reset();
    expect(add(f, "comment")).toBe("comment:work-1:502");
    expect(floorOf(f, "comment")).toEqual(floorAt("comment", "work-1", 502));
    expect(historyReads(f.log)).toEqual([]);
    expect(f.decoded.allocation).toBe(0);
  }),
  30_000,
);
