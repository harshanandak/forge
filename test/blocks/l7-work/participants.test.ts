import { afterEach, beforeEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import {
  type LeaseStateClient,
  createStateClient,
} from "../../../src/assembly/state-client.ts";
import { StateOwner } from "../../../src/core/state/index.ts";
import { dispatch, success } from "../../../src/surface/dispatch.ts";
import { candidate } from "../../surface/fixtures/catalog.ts";
import { bindContext } from "../../../src/contract/context.ts";
import { refuse } from "../../../src/core/trust/index.ts";
import { exitCode, failure } from "../../../src/surface/result.ts";
import { ForgeFailure } from "../../../src/contract/failure.ts";
import type { HandlerCall } from "../../../src/contract/author.ts";
import type {
  Attempt,
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
const receipts = new Map<
  string,
  { id: string; status: string; subject?: string }
>();
let intercept: ((state: LeaseStateClient) => LeaseStateClient) | undefined;
const globals = globalThis as Record<string, unknown>;
const ops = require(resolve(root, "entry.cts")) as Record<string, Handler>;
let p: Awaited<ReturnType<typeof project>>;
beforeEach(async () => {
  intercept = undefined;
  receipts.clear();
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
    const name = op.includes(".") ? op : `issue.${op}`;
    const bound = bindContext(manifest.operations[name]!, {
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
    const wrap = (view: LeaseStateClient): LeaseStateClient => {
      const wrapped = {
        ...view,
        withOwnLease: (subject: string) => wrap(view.withOwnLease(subject)),
      };
      return intercept?.(wrapped) ?? wrapped;
    };
    globals.fail = refuse;
    try {
      return (await ops[name]!({
        input: { id: "shown-1", ...input },
        config: { idPrefix: "shown", claimTtlSeconds: 60 },
        signal: new AbortController().signal,
        deadline: Number.MAX_SAFE_INTEGER,
        services: {
          state: wrap({ ...state, now: () => now }),
          receipts: { get: (id: string) => receipts.get(id) },
        },
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
  return (error as ForgeFailure).error;
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

type AttemptsView = Omit<TrackerItem, "mode"> & {
  mode: "competing";
  slots: number;
  attempts: Attempt[];
};
async function competing(count = 2) {
  await p.call("claim");
  await p.call("attempt.slots", A, { count });
}
async function attempt(caller: LeaseHolder, ttlSeconds = 120) {
  const result = await p.call<Attempt>("attempt.reserve", caller, {
    label: caller.session.id,
    ttlSeconds,
  });
  expect(result.id).toMatch(/^attempt-[1-9]\d*$/);
  return result;
}
test("two open slots admit exactly two concurrent competitors without a refused write", async () => {
  await competing();
  const coordinator = p.held(),
    revision = p.owner.get(ns, "issue:work-1")!.revision;
  const [b, c] = await Promise.all([
    attempt(B),
    attempt(C),
    refused("ATTEMPT_SLOTS_FULL", () => p.call("attempt.reserve", D)),
  ]);
  expect([b.id, c.id]).toEqual(["attempt-1", "attempt-2"]);
  const leases = p.owner
    .export()
    .leases.filter(({ lease }) => ["B", "C"].includes(lease.holder.session.id));
  expect(new Set(leases.map(({ lease }) => lease.subject)).size).toBe(2);
  for (const { lease } of leases) {
    expect(lease.subject).not.toBe(coordinator!.subject);
    expect(lease.generation).toBe(1);
  }
  const view = await p.call<AttemptsView>("show");
  expect(view).toMatchObject({ mode: "competing", slots: 2 });
  expect(view.attempts).toHaveLength(2);
  for (const [index, holder] of [B, C].entries()) {
    expect(view.attempts[index]).toMatchObject({
      id: `attempt-${index + 1}`,
      label: holder.session.id,
      holder,
      baseRevision: revision,
      createdAt: "2026-11-10T12:00:00.000Z",
      live: true,
      generation: 1,
      expiresAt: "2026-11-10T12:02:00.000Z",
    });
    const record = p.owner
      .export()
      .records.find(
        (row) => (row.value as { id?: string }).id === `attempt-${index + 1}`,
      );
    expect(record?.value).toMatchObject({
      id: `attempt-${index + 1}`,
      holder,
      baseRevision: revision,
    });
  }
  await refused("ATTEMPT_SLOTS_FULL", async () => {
    try {
      await p.call("attempt.reserve", D);
    } catch (error) {
      for (const detail of ["2", "attempt-1", "attempt-2"])
        expect((error as ForgeFailure).message).toContain(detail);
      throw error;
    }
  });
  expect(p.held()).toEqual(coordinator);
}, 10000);
test("a live retry is unchanged and expired or released ids are never reused", async () => {
  await competing();
  const b = await attempt(B, 1);
  await attempt(C);
  const before = p.snapshot();
  expect(
    await p.call("attempt.reserve", B, { label: "retry", ttlSeconds: 60 }),
  ).toEqual(b);
  expect(p.snapshot()).toEqual(before);
  p.advance(1000);
  expect((await attempt(D)).id).toBe("attempt-3");
  await p.call("attempt.release", C, { attempt: "attempt-2" });
  expect((await attempt(C)).id).toBe("attempt-4");
  const view = await p.call<AttemptsView>("show");
  expect(view.attempts.map(({ id, live }) => ({ id, live }))).toEqual([
    { id: "attempt-1", live: false },
    { id: "attempt-2", live: false },
    { id: "attempt-3", live: true },
    { id: "attempt-4", live: true },
  ]);
}, 10000);
test("ambient generations cannot authorize expired or other attempts, or reject an own live note", async () => {
  await competing();
  await attempt(B, 1);
  await attempt(C);
  p.advance(1000);
  await attempt(D);
  await refused("LEASE_EXPIRED", () =>
    p.call("attempt.note", B, { attempt: "attempt-1", body: "expired" }, 2),
  );
  await refused("LEASE_NOT_HELD", () =>
    p.call("attempt.note", C, { attempt: "attempt-3", body: "other" }, 2),
  );
  await refused("LEASE_STALE", () =>
    p.owner.put(ns, "stale-note", { body: "stale" }, C.actor, {
      expectRevision: 0,
      fence: {
        ...p.owner
          .export()
          .leases.find(({ lease }) => lease.holder.session.id === "C")!.lease,
        holder: C,
        generation: 2,
      },
    }),
  );
  await p.call(
    "attempt.note",
    C,
    { attempt: "attempt-2", body: "proposal" },
    2,
  );
  expect(
    p.owner
      .export()
      .records.some(
        (row) => (row.value as { body?: string }).body === "proposal",
      ),
  ).toBe(true);
  await p.call("attempt.release", C, { attempt: "attempt-2" });
  await refused("LEASE_NOT_HELD", () =>
    p.call("attempt.note", C, { attempt: "attempt-2", body: "released" }),
  );
}, 10000);
test("dispatch releases its own attempt after the coordinator expires, retaining history", async () => {
  await competing();
  await attempt(C);
  await attempt(D);
  p.advance(60000);
  expect((await p.call<AttemptsView>("show")).lease).toBeUndefined();
  const result = await dispatch(
    {
      list: () =>
        ["issue.show", "attempt.release"].map((op) =>
          candidate(op, manifest.operations[op]),
        ),
      invoke: async (req) =>
        success(
          req.op,
          await p.call(
            req.op,
            C,
            req.input as Record<string, unknown>,
            req.context?.leaseGeneration ?? null,
          ),
        ),
    },
    "attempt.release",
    { id: "shown-1", attempt: "attempt-1" },
    { caller: "agent", context: { ...C, project: { id: "test" } } },
  );
  expect(result.ok).toBe(true);
  expect(
    (await p.call<AttemptsView>("show")).attempts.map(({ id, live }) => ({
      id,
      live,
    })),
  ).toEqual([
    { id: "attempt-1", live: false },
    { id: "attempt-2", live: true },
  ]);
  await refused("LEASE_NOT_HELD", () =>
    p.call("attempt.release", C, { attempt: "attempt-1" }),
  );
  await refused("LEASE_NOT_HELD", () =>
    p.call("attempt.release", C, { attempt: "attempt-2" }),
  );
}, 10000);
test("slot changes require the coordinator fence, validate N and never evict live attempts", async () => {
  await competing();
  const before = p.snapshot();
  await p.call("attempt.slots", A, { count: 2 });
  expect(p.snapshot()).toEqual(before);
  await refused("LEASE_NOT_HELD", () =>
    p.call("attempt.slots", B, { count: 2 }),
  );
  await refused("LEASE_STALE", () =>
    p.owner.putMany(ns, [], A.actor, {
      fence: { ...p.held()!, generation: 2 },
    }),
  );
  for (const count of [0, 17, 1.5])
    await refused("INPUT_INVALID", () => p.call("attempt.slots", A, { count }));
  await attempt(B);
  await attempt(C);
  await refused("INPUT_CONFLICT", () =>
    p.call("attempt.slots", A, { count: 1 }),
  );
  p.advance(60000);
  await refused("LEASE_EXPIRED", () =>
    p.call("attempt.slots", A, { count: 2 }),
  );
}, 10000);
test("exclusive and closed reservations refuse, while the coordinator may compete", async () => {
  await p.call("claim");
  await refused("ISSUE_NOT_COMPETING", () => p.call("attempt.reserve", B));
  await p.call("attempt.slots", A, { count: 1 });
  expect((await attempt(A)).id).toBe("attempt-1");
  await p.call("attempt.evidence", A, {
    attempt: "attempt-1",
    sha: "a".repeat(40),
  });
  await p.call("attempt.select", A, {
    attempt: "attempt-1",
    reason: "Fixture selection",
  });
  await p.call("close", A, { withoutReceipt: "attempt fixture" });
  await refused("INPUT_CONFLICT", () => p.call("attempt.reserve", B));
}, 10000);
test("attempt holders cannot mutate the coordinator's issue", async () => {
  await competing();
  await attempt(B);
  for (const op of ["update", "release", "close"])
    await refused("LEASE_NOT_HELD", () =>
      p.call(op, B, {
        title: "unauthorized",
        expectRevision: p.owner.get(ns, "issue:work-1")!.revision,
        withoutReceipt: "attempt fixture",
      }),
    );
}, 10000);
test("collaborative show remains byte-identical without competing slots", async () => {
  await p.call("claim");
  const solo = await p.call<TrackerItem>("show");
  await p.invite(B);
  await p.call("join", B);
  const member = p.owner
    .export()
    .leases.find(({ lease }) => lease.holder.session.id === "B")!.lease;
  expect(JSON.stringify(await p.call("show"))).toBe(
    JSON.stringify({ ...solo, mode: "collaborative", participants: [member] }),
  );
}, 10000);
test("attempt operations declare their actual lease modes and generated surfaces", () => {
  const docs = read<DocsRecords>("docs.json");
  for (const [op, leaseMode] of [
    ["slots", "acquire"],
    ["reserve", "acquire"],
    ["release", "acquire"],
    ["note", "acquire"],
  ]) {
    expect(manifest.operations[`attempt.${op}`]).toMatchObject({
      context: "leased",
      leaseMode,
      effects: ["attempt:write"],
      callers: ["agent", "human"],
      args: ["id"],
    });
    expect(docs.operations[`attempt.${op}`]).toBeDefined();
  }
}, 10000);

const sha = "a".repeat(40),
  other = "b".repeat(40);
const act = (
  op: string,
  input: Record<string, unknown> = {},
  who = A,
  generation = 1,
) => p.call<Record<string, unknown>>(op, who, input, generation);
async function evidenceTeam() {
  await competing();
  await attempt(B);
  await attempt(C);
}
const seed = (key: string, value: object) =>
  p.owner.put(ns, key, value, A.actor, {
    expectRevision: p.owner.get(ns, key)?.revision ?? 0,
  });
function seedEvidence(attempt = "attempt-1", commit = sha) {
  const prefix = `evidence:attempt:work-1:${attempt}:`;
  seed(prefix + (p.owner.count(ns, prefix) + 1), {
    attempt,
    sha: commit,
    holder: attempt === "attempt-1" ? B : C,
    recordedAt: "2026-11-10T12:00:00.000Z",
  });
}
function seedSelection() {
  seed("selection:work-1", {
    mode: "single",
    chosen: [{ attempt: "attempt-1", sha }],
    reason: "R",
    holder: A,
    selectedAt: "2026-11-10T12:00:00.000Z",
  });
  const row = p.owner.get(ns, "attempt:work-1:attempt-2")!;
  seed(row.key, {
    ...(row.value as object),
    superseded: { supersededBy: "selection", reason: "R" },
  });
}
async function refusedOp(
  op: string,
  input: Record<string, unknown>,
  code: string,
  who = A,
  generation = 1,
) {
  const error = await refused(code, () => act(op, input, who, generation));
  expect(exitCode(failure(error.code, error.message))).toBe(
    code === "INPUT_INVALID" ? 6 : code.startsWith("RECEIPT_") ? 1 : 4,
  );
  return error;
}
const select = { attempt: "attempt-1", reason: "R" };
const evidence = { attempt: "attempt-1", sha };
function onSelectionWrite(change: () => void) {
  intercept = (state) => ({
    ...state,
    putMany(entries, options) {
      if (entries.some((e) => e.key === "selection:work-1")) {
        intercept = undefined;
        change();
      }
      return state.putMany(entries, options);
    },
  });
}
test("evidence ok appends under B lease and preserves notes", async () => {
  await evidenceTeam();
  await act("attempt.note", { attempt: "attempt-1", body: "keep" }, B);
  const notes = p.owner.list(ns, "note:"),
    leases = p.owner.export().leases;
  await act(
    "attempt.evidence",
    { ...evidence, review: "review", metrics: { time: 3, quality: "good" } },
    B,
    99,
  );
  expect(p.owner.list(ns, "evidence:").map((r) => r.value)).toEqual([
    {
      ...evidence,
      review: "review",
      metrics: { time: 3, quality: "good" },
      holder: B,
      recordedAt: "2026-11-10T12:00:00.000Z",
    },
  ]);
  expect(await act("issue.show")).toMatchObject({
    attempts: [
      { id: "attempt-1", evidence: 1 },
      { id: "attempt-2", evidence: 0 },
    ],
  });
  await act("attempt.evidence", { ...evidence, sha: other }, B);
  expect(p.owner.count(ns, "evidence:")).toBe(2);
  expect(p.owner.list(ns, "note:")).toEqual(notes);
  expect(p.owner.export().leases).toEqual(leases);
}, 10000);
test("evidence receipt stores a matching PASS receipt", async () => {
  await evidenceTeam();
  receipts.set("pass", { id: "pass", status: "PASS", subject: sha });
  await act("attempt.evidence", { ...evidence, receipt: "pass" }, B);
  expect(p.owner.list(ns, "evidence:")[0]?.value).toMatchObject({
    receipt: "pass",
    sha,
  });
}, 10000);
test("evidence bad receipt uses close refusal codes without writes", async () => {
  await evidenceTeam();
  for (const [id, status, subject, code] of [
    ["missing", "PASS", sha, "RECEIPT_INVALID"],
    ["fail", "FAIL", sha, "RECEIPT_INVALID"],
    ["wrong", "PASS", other, "RECEIPT_HEAD_MISMATCH"],
  ]) {
    if (id !== "missing")
      receipts.set(id!, { id: id!, status: status!, subject: subject! });
    await refusedOp("attempt.evidence", { ...evidence, receipt: id }, code!, B);
  }
}, 10000);
test("evidence not holder, missing, released and expired refuse without writes", async () => {
  await evidenceTeam();
  await refusedOp("attempt.evidence", evidence, "LEASE_NOT_HELD", C);
  await refusedOp(
    "attempt.evidence",
    { ...evidence, attempt: "attempt-9" },
    "LEASE_NOT_HELD",
    B,
  );
  await act("attempt.release", { attempt: "attempt-1" }, B);
  await refusedOp("attempt.evidence", evidence, "LEASE_NOT_HELD", B);
  p.advance(120000);
  await refusedOp(
    "attempt.evidence",
    { ...evidence, attempt: "attempt-2" },
    "LEASE_EXPIRED",
    C,
  );
}, 10000);
test("evidence bad input refuses sha, nested metrics and 33 keys", async () => {
  await evidenceTeam();
  for (const input of [
    { ...evidence, sha: "abc" },
    { ...evidence, metrics: { nested: {} } },
    {
      ...evidence,
      metrics: Object.fromEntries(Array.from({ length: 33 }, (_, n) => [n, n])),
    },
  ])
    await refusedOp("attempt.evidence", input, "INPUT_INVALID", B);
}, 10000);
test("select single uses latest evidence and supersedes only unchosen records", async () => {
  await evidenceTeam();
  seedEvidence();
  seedEvidence("attempt-1", other);
  seedEvidence("attempt-2");
  await act("attempt.note", { attempt: "attempt-2", body: "keep" }, C);
  const before = p.snapshot();
  await act("attempt.select", { ...select, reason: "  R  " });
  expect(p.owner.get(ns, "selection:work-1")?.value).toEqual({
    mode: "single",
    chosen: [{ attempt: "attempt-1", sha: other }],
    reason: "R",
    holder: A,
    selectedAt: "2026-11-10T12:00:00.000Z",
  });
  expect(p.owner.get(ns, "attempt:work-1:attempt-2")?.value).toMatchObject({
    superseded: { supersededBy: "selection", reason: "R" },
  });
  expect(await act("issue.show")).toMatchObject({
    selection: { mode: "single" },
    attempts: [
      { id: "attempt-1", evidence: 2 },
      { id: "attempt-2", evidence: 1, superseded: { reason: "R" } },
    ],
  });
  expect(p.snapshot().leases).toEqual(before.leases);
  const retained = (rows: typeof before.records) =>
    rows.filter((r) => !/^(selection|attempt):/.test(r.key));
  expect(retained(p.snapshot().records)).toEqual(retained(before.records));
}, 10000);
test("select combine accepts recorded older sha and supersedes none", async () => {
  await evidenceTeam();
  seedEvidence();
  seedEvidence("attempt-1", other);
  seedEvidence("attempt-2", other);
  const attempts = p.owner.list(ns, "attempt:");
  await act("attempt.select", {
    combine: `attempt-1:${sha},attempt-2:${other}`,
    reason: "combine",
  });
  expect(p.owner.get(ns, "selection:work-1")?.value).toMatchObject({
    mode: "combine",
    chosen: [
      { attempt: "attempt-1", sha },
      { attempt: "attempt-2", sha: other },
    ],
  });
  expect(p.owner.list(ns, "attempt:")).toEqual(attempts);
}, 10000);
test("select no evidence names the missing attempt without writes", async () => {
  await evidenceTeam();
  seedEvidence();
  for (const input of [
    { ...select, attempt: "attempt-2" },
    { ...select, attempt: "attempt-9" },
    { combine: `attempt-2:${other}`, reason: "R" },
  ])
    expect(
      (await refusedOp("attempt.select", input, "INPUT_CONFLICT")).message,
    ).toContain("attempt" in input ? input.attempt : "attempt-2");
}, 10000);
test("stale coordinator select preserves the attempt slots fence", async () => {
  await evidenceTeam();
  seedEvidence();
  await refusedOp("attempt.select", select, "LEASE_NOT_HELD", B);
  await act("issue.release");
  await refusedOp("attempt.select", select, "LEASE_NOT_HELD");
  await act("issue.claim");
  p.advance(60000);
  await refusedOp("attempt.select", select, "LEASE_EXPIRED", A, 2);
}, 10000);
test("race interleaves two selections and the loser writes nothing", async () => {
  await evidenceTeam();
  seedEvidence();
  seedEvidence("attempt-2", other);
  let winner: Promise<unknown> | undefined,
    accepted: ReturnType<typeof p.snapshot> | undefined;
  onSelectionWrite(() => {
    winner = act("attempt.select", { attempt: "attempt-2", reason: "winner" });
    accepted = p.snapshot();
  });
  const results = await Promise.allSettled([
    act("attempt.select", select).then(() => "OK"),
    Promise.resolve().then(() => winner),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([
    "fulfilled",
    "rejected",
  ]);
  expect(p.owner.count(ns, "selection:")).toBe(1);
  expect(p.snapshot()).toEqual(accepted!);
}, 10000);
test("stale coordinator generation changes before selection commit write nothing", async () => {
  await evidenceTeam();
  seedEvidence();
  let changed: ReturnType<typeof p.snapshot> | undefined;
  onSelectionWrite(() => {
    p.owner.release(ns, p.held()!);
    p.owner.acquire(ns, "issue:work-1", A, 60000, "next-generation");
    changed = p.snapshot();
  });
  await expect(act("attempt.select", select)).rejects.toMatchObject({
    error: { code: "LEASE_STALE" },
  });
  expect(p.snapshot()).toEqual(changed!);
}, 10000);
test("second select refuses Already selected without writes", async () => {
  await evidenceTeam();
  seedEvidence();
  seedSelection();
  expect(
    (await refusedOp("attempt.select", select, "INPUT_CONFLICT")).message,
  ).toContain("Already selected");
}, 10000);
test("close guard names selection repair without writes", async () => {
  await evidenceTeam();
  expect(
    (
      await refusedOp(
        "issue.close",
        { withoutReceipt: "done" },
        "INPUT_CONFLICT",
      )
    ).repair,
  ).toContain(
    'forge attempt select shown-1 --attempt <attempt-id> --reason "<why>"',
  );
}, 10000);
test("close after select and reopen keeps selection, superseded and evidence", async () => {
  await evidenceTeam();
  seedEvidence();
  seedSelection();
  const selected = p.owner.get(ns, "selection:work-1")!.value,
    superseded = { supersededBy: "selection", reason: "R" },
    evidenceRows = p.owner.list(ns, "evidence:");
  expect(await act("issue.close", { withoutReceipt: "done" })).toMatchObject({
    status: "closed",
  });
  await act("issue.claim", { reopen: "again" });
  expect(await act("issue.show")).toMatchObject({
    status: "open",
    selection: selected,
    attempts: [
      { id: "attempt-1", evidence: 1 },
      { id: "attempt-2", evidence: 0, superseded },
    ],
  });
  expect(p.owner.list(ns, "evidence:")).toEqual(evidenceRows);
}, 10000);

for (const close of [true, false])
  test(
    close
      ? "close race refuses slots added before commit"
      : "single selection refuses a newer evidence append",
    async () => {
      if (close) await act("issue.claim");
      else {
        await evidenceTeam();
        seedEvidence();
      }
      let changed: ReturnType<typeof p.snapshot> | undefined,
        concurrent: Promise<unknown> | undefined;
      const change = () => {
        intercept = undefined;
        concurrent = close
          ? act("attempt.slots", { count: 2 })
          : act("attempt.evidence", { ...evidence, sha: other }, B);
        changed = p.snapshot();
      };
      if (close)
        intercept = (state) => ({
          ...state,
          put(k, v, o) {
            change();
            return state.put(k, v, o);
          },
        });
      else onSelectionWrite(change);
      await expect(
        act(
          close ? "issue.close" : "attempt.select",
          close ? { withoutReceipt: "done" } : select,
        ),
      ).rejects.toMatchObject({ error: { code: "REVISION_CONFLICT" } });
      await concurrent;
      expect(p.snapshot()).toEqual(changed!);
    },
    10000,
  );
test("commit ids normalize across evidence, receipts and combine", async () => {
  await evidenceTeam();
  receipts.set("upper", {
    id: "upper",
    status: "PASS",
    subject: sha.toUpperCase(),
  });
  await act(
    "attempt.evidence",
    { ...evidence, sha: sha.toUpperCase(), receipt: "upper" },
    B,
  );
  expect(p.owner.list(ns, "evidence:")[0]!.value).toMatchObject({ sha });
  await act("attempt.evidence", { attempt: "attempt-2", sha }, C);
  await act("attempt.select", {
    combine: `attempt-1:${sha},attempt-2:${sha.toUpperCase()}`,
    reason: "case",
  });
  expect(p.owner.get(ns, "selection:work-1")!.value).toMatchObject({
    chosen: [
      { attempt: "attempt-1", sha },
      { attempt: "attempt-2", sha },
    ],
  });
}, 10000);
test("selection refuses later reservations without writes", async () => {
  await evidenceTeam();
  seedSelection();
  expect(
    (await refusedOp("attempt.reserve", {}, "INPUT_CONFLICT", B)).message,
  ).toBe("Already selected");
}, 10000);
test("none selection supersedes every attempt without evidence and allows close", async () => {
  await evidenceTeam();
  await act("attempt.select", { none: true, reason: "R" });
  const selection = (await act("issue.show")).selection;
  expect(selection).toMatchObject({ mode: "none", chosen: [], reason: "R" });
  for (const row of p.owner.list(ns, "attempt:"))
    expect(row.value).toMatchObject({
      superseded: { supersededBy: "selection", reason: "R" },
    });
  expect(await act("issue.close", { withoutReceipt: "done" })).toMatchObject({
    status: "closed",
  });
}, 10000);
