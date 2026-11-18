import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import { StateOwner } from "../../../src/core/state/index.ts";
import { createStateClient } from "../../../src/assembly/state-client.ts";
import { refuse } from "../../../src/core/trust/index.ts";
import type { HandlerCall } from "../../../src/contract/author.ts";
import type { BoundContext } from "../../../src/generated/types.ts";
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
async function fixture(leaseSubject?: string) {
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
  const holder = { actor, session: { id: "freeze" } };
  const project = { id: "freeze" };
  let context: BoundContext = { variant: "project", actor, project };
  if (leaseSubject !== undefined) {
    const lease = owner.acquire(
      namespace,
      leaseSubject,
      holder,
      60_000,
      "claim",
    );
    context = {
      variant: "leased",
      ...holder,
      project,
      leaseMode: "held",
      leaseGeneration: lease.generation,
    };
  }
  const state = createStateClient({
    owner,
    namespace,
    context,
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
  let afterRead = (_key: string) => {};
  const raced = {
    ...state,
    get: (key: string) => {
      const row = state.get(key);
      afterRead(key);
      return row;
    },
    put: (...args: Parameters<typeof state.put>) => {
      beforeWrite();
      return state.put(...args);
    },
    putNext: (...args: Parameters<typeof state.putNext>) => {
      beforeWrite();
      return state.putNext(...args);
    },
    renew: (...args: Parameters<typeof state.renew>) => {
      beforeWrite();
      return state.renew(...args);
    },
    release: (...args: Parameters<typeof state.release>) => {
      beforeWrite();
      return state.release(...args);
    },
    releaseOwn: (...args: Parameters<typeof state.releaseOwn>) => {
      beforeWrite();
      return state.releaseOwn(...args);
    },
  };
  const run = (op: string, input: Record<string, unknown> = {}) =>
    operations[op]!({
      input,
      services: { state: raced },
      config: {},
    } as unknown as HandlerCall<Record<string, unknown>>);
  return {
    owner,
    holder,
    run,
    interrupt,
    onRead: (observe: typeof afterRead) => {
      afterRead = observe;
    },
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

test("lane stop and resume leave frozen control state unchanged", async () => {
  const { owner, run, close } = await fixture();
  run("lane.freeze");
  const before = owner.events(namespace);
  for (const op of ["lane.stop", "lane.resume"])
    expect(refusal(() => run(op, { all: true })).code).toBe("UNAVAILABLE");
  expect(owner.events(namespace)).toEqual(before);
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

for (const [op, subject, row] of [
  ["issue.renew", "issue:work-1"],
  ["issue.release", "issue:work-1"],
  ["issue.leave", "issue:participant:work-1:1", "participant:work-1:1"],
  ["attempt.release", "issue:attempt:work-1:1", "attempt:work-1:1"],
] as const) {
  test(`${op} changes neither the lease nor its events when a freeze lands`, async () => {
    const { owner, holder, run, interrupt, close } = await fixture(subject);
    try {
      if (row !== undefined)
        owner.put(namespace, row, { holder }, actor, { expectRevision: 0 });
      const lease = owner.lease(namespace, subject);
      const events = owner.events(namespace, subject);
      interrupt(() => {
        owner.put(namespace, GLOBAL, { stopped: {}, frozen: at }, actor, {
          expectRevision: 0,
        });
      });
      expect(refusal(() => run(op, { id: "work-1", attempt: "1" })).code).toBe(
        "REVISION_CONFLICT",
      );
      expect(owner.lease(namespace, subject)).toEqual(lease);
      expect(owner.events(namespace, subject)).toEqual(events);
      expect(owner.get(namespace, GLOBAL)?.value).toHaveProperty("frozen");
    } finally {
      await close();
    }
  });
}

test("stop recovery cannot overwrite a freeze that lands after its snapshot", async () => {
  const { owner, run, onRead, close } = await fixture();
  try {
    owner.put(namespace, GLOBAL, { stopped: null }, actor, {
      expectRevision: 0,
    });
    let reads = 0;
    onRead((key) => {
      if (key === GLOBAL && ++reads === 2)
        owner.put(namespace, GLOBAL, { stopped: {}, frozen: at }, actor, {
          expectRevision: 1,
        });
    });
    expect(refusal(() => run("lane.stop", { all: true })).code).toBe(
      "REVISION_CONFLICT",
    );
    expect(owner.get(namespace, GLOBAL)).toMatchObject({
      revision: 2,
      value: { stopped: {}, frozen: at },
    });
  } finally {
    await close();
  }
});

test("lane stop on an unreadable freeze time leaves control state unchanged", async () => {
  const { owner, run, close } = await fixture();
  owner.put(namespace, GLOBAL, { stopped: {}, frozen: "not a time" }, actor, {
    expectRevision: 0,
  });
  expect(refusal(() => run("lane.stop", { all: true })).code).toBe(
    "UNAVAILABLE",
  );
  expect(owner.get(namespace, GLOBAL)).toMatchObject({
    revision: 1,
    value: { frozen: "not a time" },
  });
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
  expect(refusal(() => run("lane.stop", { all: true })).code).toBe(
    "UNAVAILABLE",
  );
  expect(owner.get(namespace, GLOBAL)).toMatchObject({
    revision: 1,
    value: { owner: "unreadable", frozen: at },
  });
  expect(
    refusal(() => run("issue.create", { title: "after" })).message,
  ).toContain("frozen since");
  await close();
});
