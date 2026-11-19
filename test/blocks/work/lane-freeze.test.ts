import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import { StateOwner } from "../../../src/core/state/index.ts";
import { createStateClient } from "../../../src/assembly/state-client.ts";
import { refuse } from "../../../src/core/trust/index.ts";
import type { HandlerCall } from "../../../src/contract/author.ts";
import manifest from "../../../src/blocks/work/forge.block.json" with { type: "json" };

setDefaultTimeout(30_000);
const globals = globalThis as Record<string, unknown>,
  prior = globals.fail;
const operations = require("../../../src/blocks/work/entry.cts") as Record<
  string,
  (call: HandlerCall<Record<string, unknown>>) => unknown
>;
beforeAll(() => {
  globals.fail = refuse;
});
afterAll(() => {
  if (prior === undefined) delete globals.fail;
  else globals.fail = prior;
});
const namespace = "forge/work",
  at = "2026-01-01T00:00:00.000Z",
  GLOBAL = "autopilot:global";
const actor = { kind: "agent", id: "freeze" } as const;
async function fixture() {
  const opened = await createSqliteStore(process.cwd()).open({
    path: ":memory:",
    readOnly: false,
  });
  if (!opened.ok) throw new Error("Fixture store refused");
  const owner = new StateOwner(
    opened.handle.value,
    { now: () => Date.parse(at) },
    [
      {
        namespace,
        families: { fixture: { key: /[\s\S]+/, admit: () => undefined } },
      },
    ],
  );
  owner.initialize();
  owner.put(
    namespace,
    "issue:work-1",
    {
      id: "work-1",
      title: "one",
      status: "open",
      labels: [],
      dependsOn: [],
      createdAt: at,
    },
    actor,
    { expectRevision: 0 },
  );
  const state = createStateClient({
    owner,
    namespace,
    context: { variant: "project", actor, project: { id: "freeze" } },
    write: true,
    requestId: "freeze",
  });
  let beforeWrite = () => {};
  const interrupt = (work: () => void) => {
    beforeWrite = () => {
      beforeWrite = () => {};
      work();
    };
  };
  const raced = {
    ...state,
    put: (...args: Parameters<typeof state.put>) => {
      beforeWrite();
      return state.put(...args);
    },
    putNext: (...args: Parameters<typeof state.putNext>) => {
      beforeWrite();
      return state.putNext(...args);
    },
  };
  const run = (
    op: string,
    input: Record<string, unknown> = {},
    bound: typeof state = raced,
  ) =>
    operations[op]!({
      input,
      services: { state: bound },
      config: {},
    } as unknown as HandlerCall<Record<string, unknown>>);
  return {
    owner,
    state: raced,
    run,
    interrupt,
    close: () => opened.handle.close(),
  };
}
const frozenAt = (result: unknown) => (result as { at: string }).at;
const refusal = (work: () => unknown) => {
  try {
    work();
  } catch (error) {
    return (
      error as { error: { code: string; message: string; repair?: string } }
    ).error;
  }
  throw new Error("Expected a refusal");
};

test("freeze is recorded in the store and refuses later issue writes", async () => {
  const { owner, run, close } = await fixture();
  const since = frozenAt(run("lane.freeze"));
  expect(owner.get(namespace, GLOBAL)?.value).toMatchObject({ frozen: since });
  const before = owner.list(namespace, "issue:").length;
  const error = refusal(() => run("issue.create", { title: "after" }));
  expect(error.code).toBe("UNAVAILABLE");
  expect(error.message).toContain(`frozen since ${since}`);
  expect(error.repair).toContain("forge auth login");
  expect(owner.list(namespace, "issue:").length).toBe(before);
  await close();
});

test("a frozen store still serves reads", async () => {
  const { run, close } = await fixture();
  run("lane.freeze");
  expect(run("issue.show", { id: "work-1" })).toMatchObject({ id: "work-1" });
  expect(run("issue.list", {})).toMatchObject({ items: [{ id: "work-1" }] });
  await close();
});

test("a second freeze writes nothing", async () => {
  const { owner, run, close } = await fixture();
  const since = frozenAt(run("lane.freeze"));
  const revision = owner.get(namespace, GLOBAL)?.revision;
  expect(run("lane.freeze")).toEqual({ frozen: true, at: since });
  expect(owner.get(namespace, GLOBAL)?.revision).toBe(revision);
  await close();
});

test("unfreeze lifts the freeze and issue writes work again", async () => {
  const { owner, run, close } = await fixture();
  run("lane.freeze");
  expect(run("lane.unfreeze")).toEqual({ frozen: false });
  expect(owner.get(namespace, GLOBAL)?.value).not.toHaveProperty("frozen");
  expect(run("issue.create", { title: "after" })).toMatchObject({
    title: "after",
  });
  expect(run("lane.unfreeze")).toEqual({ frozen: false });
  await close();
});

test("lane stop and resume keep the freeze", async () => {
  const { owner, run, close } = await fixture();
  const since = frozenAt(run("lane.freeze"));
  run("lane.stop", { all: true });
  run("lane.resume", { all: true });
  expect(owner.get(namespace, GLOBAL)?.value).toMatchObject({ frozen: since });
  await close();
});

test("every issue and attempt write is gated", async () => {
  const { run, close } = await fixture();
  run("lane.freeze");
  const declared = manifest.operations as Record<
    string,
    { effects: string[]; callers: string[] } | undefined
  >;
  const writes = Object.entries(declared)
    .filter(
      ([op, declaration]) =>
        !op.endsWith("freeze") &&
        (declaration!.effects.includes("issue:write") ||
          declaration!.effects.includes("attempt:write")),
    )
    .map(([op]) => op);
  expect(writes.length).toBeGreaterThan(15);
  for (const op of [...writes, "lane.attempt"])
    expect(refusal(() => run(op, { id: "work-1" })).message).toContain(
      "frozen since",
    );
  await close();
});

test("a freeze that lands between the check and the write refuses the write", async () => {
  const { owner, run, interrupt, close } = await fixture();
  interrupt(() => {
    owner.put(namespace, GLOBAL, { stopped: {}, frozen: at }, actor, {
      expectRevision: 0,
    });
  });
  const before = owner.list(namespace, "issue:").length;
  expect(() => run("issue.create", { title: "racing" })).toThrow();
  expect(owner.list(namespace, "issue:").length).toBe(before);
  expect(owner.get(namespace, GLOBAL)?.value).toMatchObject({ frozen: at });
  await close();
});

test("lane stop on an unreadable freeze time keeps the store frozen", async () => {
  const { owner, run, close } = await fixture();
  owner.put(namespace, GLOBAL, { stopped: {}, frozen: "not a time" }, actor, {
    expectRevision: 0,
  });
  run("lane.stop", { all: true });
  const stored = owner.get(namespace, GLOBAL)?.value as { frozen: string };
  expect(Number.isNaN(Date.parse(stored.frozen))).toBe(false);
  expect(
    refusal(() => run("issue.create", { title: "after" })).message,
  ).toContain("frozen since");
  await close();
});

test("lane stop on an unreadable control record keeps a valid freeze", async () => {
  const { owner, run, close } = await fixture();
  owner.put(
    namespace,
    GLOBAL,
    { stopped: {}, owner: "unreadable", frozen: at },
    actor,
    { expectRevision: 0 },
  );
  run("lane.stop", { all: true });
  expect(owner.get(namespace, GLOBAL)?.value).toMatchObject({ frozen: at });
  expect(
    refusal(() => run("issue.create", { title: "after" })).message,
  ).toContain("frozen since");
  await close();
});

test("stop recovery cannot overwrite a freeze committed after its snapshot", async () => {
  const f = await fixture();
  try {
    f.owner.put(namespace, GLOBAL, { owner: "unreadable" }, actor, {
      expectRevision: 0,
    });
    let reads = 0;
    const get = f.state.get.bind(f.state);
    f.state.get = (key) => {
      const record = get(key);
      if (key === GLOBAL && ++reads === 2)
        f.owner.put(namespace, GLOBAL, { stopped: {}, frozen: at }, actor, {
          expectRevision: record!.revision,
        });
      return record;
    };
    expect(() => f.run("lane.stop", { all: true })).toThrow();
    expect(f.owner.get(namespace, GLOBAL)?.value).toEqual({
      stopped: {},
      frozen: at,
    });
    expect(f.owner.events(namespace, GLOBAL)).toHaveLength(2);
  } finally {
    await f.close();
  }
});

for (const op of [
  "issue.renew",
  "issue.release",
  "issue.leave",
  "attempt.release",
])
  test(`${op} refuses a concurrent freeze without changing lease or events`, async () => {
    const f = await fixture();
    try {
      const holder = { actor, session: { id: "freeze" } };
      const recordKey =
        op === "issue.leave"
          ? "participant:work-1:1"
          : op === "attempt.release"
            ? "attempt:work-1:attempt-1"
            : "work-1";
      if (recordKey !== "work-1")
        f.owner.put(namespace, recordKey, { holder }, actor, {
          expectRevision: 0,
        });
      const subject = `issue:${recordKey}`;
      const lease = f.owner.acquire(namespace, subject, holder, 60000, "held");
      const state = createStateClient({
        owner: f.owner,
        namespace,
        context: {
          variant: "leased",
          ...holder,
          project: { id: "freeze" },
          leaseMode: "held",
          leaseGeneration: lease.generation,
        },
        write: true,
        requestId: op,
      });
      const freeze = () =>
        f.owner.put(namespace, GLOBAL, { stopped: {}, frozen: at }, actor, {
          expectRevision: 0,
        });
      const renew = f.owner.renew.bind(f.owner);
      const release = f.owner.release.bind(f.owner);
      f.owner.renew = (...args) => {
        freeze();
        return renew(...args);
      };
      f.owner.release = (...args) => {
        freeze();
        return release(...args);
      };
      const events = f.owner.events(namespace, subject);
      expect(() =>
        f.run(op, { id: "work-1", attempt: "attempt-1" }, state),
      ).toThrow();
      expect(f.owner.get(namespace, GLOBAL)?.value).toHaveProperty(
        "frozen",
        at,
      );
      expect(f.owner.lease(namespace, subject)).toEqual(lease);
      expect(f.owner.events(namespace, subject)).toEqual(events);
    } finally {
      await f.close();
    }
  });
