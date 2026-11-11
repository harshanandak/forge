import { afterEach, beforeEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import { createStateClient } from "../../../src/assembly/state-client.ts";
import { StateOwner } from "../../../src/core/state/index.ts";
import { dispatch, success } from "../../../src/surface/dispatch.ts";
import { candidate } from "../../surface/fixtures/catalog.ts";
import { bindContext } from "../../../src/contract/context.ts";
import { refuse } from "../../../src/core/trust/index.ts";
import { ForgeFailure } from "../../../src/contract/failure.ts";
import type { HandlerCall } from "../../../src/contract/author.ts";
import type {
  BlockManifest,
  DocsRecords,
  LeaseGrant,
  LeaseHolder,
  LeaseRecord,
  TrackerItem,
} from "../../../src/generated/types.ts";
type Handler = (call: HandlerCall<Record<string, unknown>>) => unknown;
type View = TrackerItem & { mode: string; participants: LeaseRecord[] };
const root = resolve(import.meta.dirname, "../../../src/blocks/work");
const ns = "forge/work";
const read = <T>(file: string) =>
  JSON.parse(readFileSync(resolve(root, file), "utf8")) as T;
const manifest = read<BlockManifest>("forge.block.json");
const who = (id: string): LeaseHolder => ({
  actor: { kind: "agent", id: "worker" },
  session: { id, device: "laptop" },
});
const A = who("A"),
  B = who("B"),
  C = who("C"),
  D = who("D");
const globals = globalThis as Record<string, unknown>;
const ops = require(resolve(root, "entry.cts")) as Record<string, Handler>;
let p: Awaited<ReturnType<typeof project>>;
beforeEach(async () => {
  p = await project();
});
afterEach(() => p.close());
async function project() {
  const opened = await createSqliteStore(tmpdir()).open({
    path: ":memory:",
    readOnly: false,
  });
  if (!opened.ok) throw new Error(opened.unavailable.reason);
  let now = Date.parse("2026-11-10T12:00:00Z");
  const owner = new StateOwner(opened.handle.value, { now: () => now });
  owner.initialize();
  for (const title of ["work-1", "work-2"]) await call("create", A, { title });
  async function call<T = unknown>(
    op: string,
    caller = A,
    input: Record<string, unknown> = {},
    generation: number | null = 1,
  ): Promise<T> {
    const bound = bindContext(manifest.operations[`issue.${op}`]!, {
      ...caller,
      project: { id: "test" },
      ...(generation === null ? {} : { leaseGeneration: generation }),
    });
    if (!bound.ok) throw new ForgeFailure(bound.error);
    const state = createStateClient({
      owner,
      namespace: ns,
      write: true,
      requestId: crypto.randomUUID(),
      context: bound.context,
    });
    const previousFail = globals.fail;
    globals.fail = refuse;
    try {
      return (await ops[`issue.${op}`]!({
        input: { id: "shown-1", ...input },
        config: { idPrefix: "shown", claimTtlSeconds: 60 },
        signal: new AbortController().signal,
        deadline: Number.MAX_SAFE_INTEGER,
        services: { state: { ...state, now: () => now } },
      })) as T;
    } finally {
      if (previousFail === undefined) delete globals.fail;
      else globals.fail = previousFail;
    }
  }
  async function cli(caller: LeaseHolder) {
    const result = await dispatch(
      {
        list: () =>
          ["issue.show", "issue.leave"].map((op) =>
            candidate(op, manifest.operations[op]),
          ),
        invoke: async (req) => {
          const value = await call(
            req.op.slice(6),
            caller,
            req.input as Record<string, unknown>,
            req.context?.leaseGeneration ?? null,
          );
          return success(req.op, value);
        },
      },
      "issue.leave",
      { id: "shown-1" },
      { caller: "agent", context: { ...caller, project: { id: "test" } } },
    );
    if (!result.ok) throw new ForgeFailure(result.error);
    return result.result;
  }
  return {
    call,
    cli,
    owner,
    close: () => opened.handle.close(),
    advance: (ms: number) => (now += ms),
    snapshot: () => {
      const { image: _image, ...state } = owner.export();
      return state;
    },
    held: () => owner.lease(ns, "issue:work-1"),
    invite: (caller: LeaseHolder) =>
      call("invite", A, {
        session: caller.session.id,
        device: caller.session.device,
      }),
  };
}
async function refused(code: string, action: () => unknown) {
  const before = p.snapshot();
  let error: unknown;
  try {
    await action();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ForgeFailure);
  expect((error as ForgeFailure).error.code).toBe(code);
  expect(p.snapshot()).toEqual(before);
}
async function collaborate() {
  await p.call("claim");
  await p.invite(B);
  await p.invite(C);
}
test("A coordinates while B and C have separate participant leases", async () => {
  await collaborate();
  const coordinator = p.held();
  for (const caller of [B, C]) await p.call("join", caller);
  const before = p.snapshot(),
    view = await p.call<View>("show");
  expect(view.mode).toBe("collaborative");
  expect(view.lease).toEqual(coordinator);
  expect(view.participants).toHaveLength(2);
  expect(
    view.participants
      .map((member) => member.holder)
      .sort((a, b) => a.session.id.localeCompare(b.session.id)),
  ).toEqual([B, C]);
  for (const member of view.participants) {
    expect(member.generation).toBe(1);
    expect(member.expiresAt).toBe("2026-11-10T12:01:00.000Z");
  }
  const leases = p.owner
    .export()
    .leases.filter((lease) => lease.namespace === ns);
  expect(new Set(leases.map(({ lease }) => lease.subject)).size).toBe(3);
  expect(p.held()).toEqual(coordinator);
  expect(p.snapshot()).toEqual(before);
}, 10000);
test("uninvited D and mismatched session or device cannot join or write", async () => {
  await collaborate();
  for (const caller of [
    D,
    { ...B, session: { ...B.session, device: "other" } },
    { ...B, session: { ...B.session, id: "other" } },
  ])
    await refused("PARTICIPANT_NOT_INVITED", () => p.call("join", caller));
}, 10000);
test("exclusive, coordinator and closed joins refuse without writes", async () => {
  await p.call("claim");
  await refused("ISSUE_NOT_COLLABORATIVE", () => p.call("join", B));
  await p.invite(B);
  await refused("INPUT_CONFLICT", () => p.call("join", A));
  await p.call("close", A, { withoutReceipt: "contract fixture" });
  await refused("INPUT_CONFLICT", () => p.call("join", B));
}, 10000);
test("participants cannot invite, update, release or close the coordinator's issue", async () => {
  await collaborate();
  for (const caller of [B, C]) {
    await p.call("join", caller);
    for (const op of ["invite", "update", "release", "close"])
      await refused("LEASE_NOT_HELD", () =>
        p.call(op, caller, {
          session: D.session.id,
          device: D.session.device,
          title: "unauthorized",
          expectRevision: p.owner.get(ns, "issue:work-1")!.revision,
          withoutReceipt: "contract fixture",
        }),
      );
  }
  expect((await p.call<View>("show")).status).toBe("open");
  expect(p.held()?.holder).toEqual(A);
}, 10000);
test("invite keeps the existing generation and expiry fence errors", async () => {
  await p.call("claim");
  await refused("LEASE_STALE", () => p.call("invite", A, { session: "B" }, 2));
  p.advance(60000);
  await refused("LEASE_EXPIRED", () => p.call("invite", A, { session: "B" }));
}, 10000);
test("duplicate invite and live rejoin do not write or extend membership", async () => {
  await collaborate();
  const invited = p.snapshot();
  await p.invite(B);
  expect(p.snapshot()).toEqual(invited);
  const joined = await p.call("join", B, { ttlSeconds: 2 });
  p.advance(1000);
  const live = p.snapshot();
  expect(await p.call("join", B, { ttlSeconds: 60 })).toEqual(joined);
  expect(p.snapshot()).toEqual(live);
}, 10000);
test("expiry hides B and reacquiring advances only B's generation", async () => {
  await collaborate();
  await p.call("join", B, { ttlSeconds: 1 });
  await p.call("join", C);
  const coordinator = p.held();
  p.advance(1000);
  expect(
    (await p.call<View>("show")).participants.map((member) => member.holder),
  ).toEqual([C]);
  await p.call("join", B, { ttlSeconds: 2 });
  const participants = (await p.call<View>("show")).participants;
  expect(
    participants.find((member) => member.holder.session.id === "B"),
  ).toMatchObject({ generation: 2, expiresAt: "2026-11-10T12:00:03.000Z" });
  expect(
    participants.find((member) => member.holder.session.id === "C")?.generation,
  ).toBe(1);
  expect(p.held()).toEqual(coordinator);
}, 10000);
test("leave releases only the caller and a refused leave writes nothing", async () => {
  await collaborate();
  for (const caller of [B, C]) await p.call("join", caller);
  const coordinator = p.held();
  await refused("LEASE_NOT_HELD", () => p.call("leave", D));
  const membership = (await p.call<View>("show")).participants[0]!;
  await refused("LEASE_STALE", () =>
    p.owner.release(ns, { ...membership, generation: 2 }),
  );
  await p.call("leave", B);
  expect(
    (await p.call<View>("show")).participants.map((member) => member.holder),
  ).toEqual([C]);
  expect(p.held()).toEqual(coordinator);
  await refused("LEASE_NOT_HELD", () => p.call("leave", B));
}, 10000);
test("solo claim, comment, update and close keep their existing result fields", async () => {
  const grant = await p.call("claim");
  expect(grant).toEqual({
    id: "shown-1",
    generation: 1,
    expiresAt: "2026-11-10T12:01:00.000Z",
  });
  expect(await p.call("comment", A, { body: "solo" })).toEqual({
    id: "shown-1",
    commentId: "comment:work-1:1",
  });
  const fields = await p.call<TrackerItem>("show");
  expect(fields).toEqual({
    id: "shown-1",
    title: "work-1",
    status: "open",
    labels: [],
    dependsOn: [],
    createdAt: "2026-11-10T12:00:00.000Z",
    updatedAt: "2026-11-10T12:00:00.000Z",
    revision: 1,
    lease: p.held()!,
  });
  const updated = await p.call<TrackerItem>("update", A, {
    title: "updated",
    expectRevision: 1,
  });
  expect(updated).toEqual({ ...fields, title: "updated", revision: 2 });
  const closed = await p.call<TrackerItem>("close", A, {
    withoutReceipt: "solo",
  });
  expect(closed).toEqual({
    ...updated,
    status: "closed",
    withoutReceipt: "solo",
    revision: 3,
  });
}, 10000);
test("invite, join and leave are declared once for generated CLI and MCP", () => {
  const docs = read<DocsRecords>("docs.json");
  for (const [op, leaseMode] of [
    ["invite", "held"],
    ["join", "acquire"],
    ["leave", "acquire"],
  ]) {
    expect(manifest.operations[`issue.${op}`]).toMatchObject({
      context: "leased",
      leaseMode,
      effects: ["issue:write"],
      callers: ["agent", "human"],
      args: ["id"],
    });
    expect(docs.operations[`issue.${op}`]).toBeDefined();
  }
}, 10000);
test("CLI dispatch leaves a reacquired membership and works after coordinator expiry", async () => {
  await p.call("claim");
  await p.invite(B);
  await p.call("join", B, { ttlSeconds: 1 });
  p.advance(1000);
  const joined = await p.call<LeaseGrant>("join", B, { ttlSeconds: 120 });
  expect(joined.generation).toBe(2);
  await p.cli(B);
  expect((await p.call<View>("show")).participants).toEqual([]);
  await p.call("join", B, { ttlSeconds: 120 });
  p.advance(60000);
  expect((await p.call<View>("show")).lease).toBeUndefined();
  await refused("LEASE_NOT_HELD", () => p.cli(D));
  await p.cli(B);
  expect((await p.call<View>("show")).participants).toEqual([]);
}, 10000);
