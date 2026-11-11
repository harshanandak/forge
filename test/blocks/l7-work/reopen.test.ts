import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  spyOn,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import { createStateClient } from "../../../src/assembly/state-client.ts";
import { ForgeFailure } from "../../../src/contract/failure.ts";
import { StateOwner } from "../../../src/core/state/index.ts";
import { refuse } from "../../../src/core/trust/index.ts";
import type { LeaseHolder } from "../../../src/generated/types.ts";

const root = resolve(import.meta.dirname, "../../../src/blocks/work");
const manifest = JSON.parse(
  readFileSync(resolve(root, "forge.block.json"), "utf8"),
) as { operations: Record<string, { leaseMode?: "acquire" | "held" }> };
const namespace = "forge/work",
  subject = "issue:work-1";
const A: LeaseHolder = {
  actor: { kind: "agent", id: "A" },
  session: { id: "A" },
};
const B: LeaseHolder = {
  actor: { kind: "agent", id: "B" },
  session: { id: "B" },
};
const globals = globalThis as Record<string, unknown>,
  previous = globals.fail;
let operations: Record<
  string,
  (call: { input: Record<string, unknown>; services: unknown }) => unknown
>;
let p: Awaited<ReturnType<typeof project>>;
beforeAll(() => {
  globals.fail = refuse;
  operations = require(resolve(root, "entry.cts")) as typeof operations;
});
afterAll(() => {
  if (previous === undefined) delete globals.fail;
  else globals.fail = previous;
});
beforeEach(async () => {
  p = await project();
});
afterEach(async () => {
  await p.close();
});

async function project() {
  const opened = await createSqliteStore(tmpdir()).open({
    path: ":memory:",
    readOnly: false,
  });
  if (!opened.ok) throw new Error(opened.unavailable.reason);
  const owner = new StateOwner(opened.handle.value, { now: () => 1000 });
  owner.initialize();
  owner.put(
    namespace,
    subject,
    {
      id: "work-1",
      title: "Keep",
      status: "open",
      labels: ["bug"],
      dependsOn: [],
      createdAt: new Date(1000).toISOString(),
    },
    A.actor,
    { expectRevision: 0 },
  );
  let request = 0;
  const call = async (
    op: string,
    input: Record<string, unknown> = {},
    who = A,
  ) => {
    const state = createStateClient({
      owner,
      namespace,
      write: true,
      requestId: `r-${++request}`,
      context: {
        variant: "leased",
        ...who,
        project: { id: "test" },
        leaseMode: manifest.operations[`issue.${op}`]!.leaseMode ?? "acquire",
        leaseGeneration: owner.lease(namespace, subject)?.generation ?? 1,
      },
    });
    return await operations[`issue.${op}`]!({
      input: { id: "work-1", ...input },
      services: { state: { ...state, now: () => 1000 } },
    });
  };
  return {
    store: opened.handle.value,
    owner,
    call,
    close: () => opened.handle.close(),
    held: () => owner.lease(namespace, subject),
    snapshot: () => {
      const { image: _image, ...state } = owner.export();
      return state;
    },
    records: () => owner.list(namespace, "reopen:work-1:"),
  };
}
async function closed(release = true) {
  await p.call("claim");
  await p.call("close", { withoutReceipt: "done", reason: "finished" });
  if (release) await p.call("release");
}
async function refusal(op: string, input = {}, who = A) {
  try {
    await p.call(op, input, who);
  } catch (error) {
    expect(error).toBeInstanceOf(ForgeFailure);
    return (error as ForgeFailure).error;
  }
  throw new Error("Expected refusal");
}

test("reopen restores authority, preserves earlier close evidence and permits update and close", async () => {
  await closed();
  const grant = await p.call("claim", { reopen: "  closed by mistake  " });
  expect(grant).toMatchObject({ id: "work-1", generation: 2 });
  expect(p.held()).toMatchObject({ generation: 2, holder: A });
  const shown = (await p.call("show")) as Record<string, unknown>;
  expect(shown).toMatchObject({
    status: "open",
    title: "Keep",
    labels: ["bug"],
    lease: { generation: 2 },
  });
  expect(shown.withoutReceipt).toBeUndefined();
  expect(shown.receipt).toBeUndefined();
  expect(shown.closeReason).toBeUndefined();
  expect(p.records().map((r) => r.value)).toEqual([
    {
      withoutReceipt: "done",
      closeReason: "finished",
      reason: "closed by mistake",
      holder: A,
    },
  ]);
  await p.call("update", {
    title: "Corrected",
    expectRevision: shown.revision,
  });
  expect(
    await p.call("close", { withoutReceipt: "really done" }),
  ).toMatchObject({ status: "closed", title: "Corrected" });
}, 10000);

test("reopen keeps a still-held lease generation and honors an explicit ttl after release", async () => {
  await closed(false);
  const lease = p.held();
  expect(await p.call("claim", { reopen: "mistake" })).toMatchObject({
    generation: lease!.generation,
  });
  expect(p.held()).toEqual(lease);
  await p.call("close", { withoutReceipt: "done" });
  await p.call("release");
  expect(
    await p.call("claim", { reopen: "again", ttlSeconds: 5 }),
  ).toMatchObject({ expiresAt: new Date(6000).toISOString() });
}, 10000);

test("another holder and cleanup reservation refuse without any state changes", async () => {
  await closed(false);
  const before = p.snapshot();
  expect((await refusal("claim", { reopen: "mistake" }, B)).code).toBe(
    "LEASE_HELD",
  );
  expect(p.snapshot()).toEqual(before);
  await p.call("release");
  p.owner.put(
    namespace,
    "cleanup:work-1",
    { expiresAt: new Date(61000).toISOString() },
    B.actor,
    { expectRevision: 0 },
  );
  const reserved = p.snapshot();
  const error = await refusal("claim", { reopen: "mistake" });
  expect(error.code).toBe("INPUT_CONFLICT");
  expect(error.message).toContain("Lane cleanup is in progress");
  expect(p.snapshot()).toEqual(reserved);
}, 10000);

test("open, unknown and invalid-reason reopens refuse without writes", async () => {
  let before = p.snapshot();
  expect(await refusal("claim", { reopen: "mistake" })).toMatchObject({
    code: "INPUT_CONFLICT",
    message: "Only closed issues can be reopened",
  });
  expect(p.snapshot()).toEqual(before);
  await closed();
  before = p.snapshot();
  for (const reopen of ["", " \t\n", "x".repeat(65537)]) {
    expect(await refusal("claim", { reopen })).toMatchObject({
      code: "INPUT_INVALID",
      message: "reason must contain 1 to 65536 characters after trimming",
    });
    expect(p.snapshot()).toEqual(before);
  }
  expect(
    (await refusal("claim", { id: "work-99", reopen: "mistake" })).code,
  ).toBe("NOT_FOUND");
  expect(p.snapshot()).toEqual(before);
}, 10000);

test("two concurrent callers produce exactly one grant and one reopen record", async () => {
  await closed();
  const results = await Promise.allSettled([
    p.call("claim", { reopen: "mistake" }, A),
    p.call("claim", { reopen: "mistake" }, B),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  expect(p.records()).toHaveLength(1);
  expect(p.held()).toMatchObject({ holder: A, generation: 2 });
}, 10000);

test("claim on a closed issue retains its refusal and names the reopen repair", async () => {
  await closed();
  const before = p.snapshot();
  expect(await refusal("claim")).toMatchObject({
    code: "INPUT_CONFLICT",
    message: "Closed issues cannot be claimed",
    repair: 'forge issue claim work-1 --reopen "<why>"',
  });
  expect(p.snapshot()).toEqual(before);
}, 10000);

test("evidence write failure rolls back the acquired lease and every state change", async () => {
  await closed();
  const before = p.snapshot(),
    run = p.store.run.bind(p.store);
  const fault = spyOn(p.store, "run").mockImplementation((sql, params) => {
    if (
      sql.includes("INSERT INTO state_records") &&
      JSON.stringify(params).includes("reopen:work-1:1")
    )
      throw new Error("injected reopen write failure");
    return run(sql, params);
  });
  try {
    await expect(p.call("claim", { reopen: "mistake" })).rejects.toThrow(
      "injected reopen write failure",
    );
    expect(p.snapshot()).toEqual(before);
  } finally {
    fault.mockRestore();
  }
}, 10000);
