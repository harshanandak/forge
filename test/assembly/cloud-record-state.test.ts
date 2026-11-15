import { expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { createCloudHttp } from "../../src/adapters/http/index.ts";
import { createCloudRecordState } from "../../src/assembly/cloud-record-state.ts";
import { CloudRecordRefusal } from "../../src/assembly/cloud-state-client.ts";
import { ForgeFailure } from "../../src/contract/failure.ts";
import { LocalState } from "../../src/assembly/state.ts";
import * as ownerState from "../../src/core/state/index.ts";
import { canonicalJson } from "../../src/core/config/pointer.ts";
import { failure } from "../../src/surface/result.ts";
import type { StateRecord } from "../../src/generated/types.ts";
import type {
  StateReadRequest,
  StateCommitRequest,
} from "../../src/ports/state-protocol.ts";
import * as fx from "./cloud-fixture.ts";

setDefaultTimeout(10_000);

const namespace = "forge/memory";
const actor = { kind: "human" as const, id: "tester" };
const context = {
  actor,
  project: { id: fx.PROJECT_ID },
  device: { id: "dev-1" },
};
type Call = StateReadRequest | StateCommitRequest;
/** Real credentialed client and decoder over injected transport, clock and abort seams. */
function fixture(write = true) {
  const clock = fx.clock(),
    controller = new AbortController();
  const records = new Map<string, StateRecord>();
  const calls: Call[] = [],
    bytes: string[] = [],
    signals: AbortSignal[] = [];
  const accepted = new Map<string, { bytes: string; result: object }>();
  let revision = 0,
    credential = true,
    offline = false,
    abortInFlight = false;
  let deny: string | undefined, loss: string | undefined;
  let principal = "aaaaaaaaaaaaaaaa";
  let concurrent = 0,
    maxConcurrent = 0;
  const refusal = (code: string, status: number) =>
    fx.json(failure(code, "refused"), status);
  const facts = () => ({
    version: 1,
    project: fx.PROJECT,
    namespace,
    policyRevision: "policy-1",
    readVersion: { epoch: "epoch-1", revision },
  });
  const ok = (result: unknown) =>
    fx.json({ ok: true, status: "OK", warnings: [], result });
  const record = (key: string, value: unknown, rev = 1): StateRecord => ({
    namespace,
    key,
    value,
    revision: rev,
    updatedAt: new Date(clock.now()).toISOString(),
    updatedBy: actor,
  });
  const event = (key: string, revision: number) => ({
    type: "forge/memory:record.put@1",
    namespace,
    key,
    revision,
    at: new Date(clock.now()).toISOString(),
    actor,
    data: revision,
  });
  const net = fx.network(async ({ body, init }) => {
    const call = body as Call;
    calls.push(call);
    bytes.push(init.body!);
    signals.push(init.signal);
    expect(call.context.project).toEqual({ id: fx.PROJECT });
    maxConcurrent = Math.max(maxConcurrent, ++concurrent);
    await Promise.resolve();
    concurrent--;
    if (abortInFlight) {
      controller.abort();
      return new Promise<Response>(() => {});
    }
    if (offline) throw Error("offline");
    if (deny) {
      const code = deny;
      deny = undefined;
      return refusal(
        code,
        code === "AUTH_FORBIDDEN"
          ? 403
          : code === "AUTH_REVOKED"
            ? 401
            : code === "UNAVAILABLE"
              ? 503
              : 409,
      );
    }
    if (call.kind === "commit") {
      const receipt = `${/^Bearer fct_([a-f0-9]{16})\./.exec(init.headers.authorization ?? "")?.[1]}:${call.requestId}`;
      const previous = accepted.get(receipt);
      if (previous)
        return previous.bytes === init.body
          ? ok(previous.result)
          : refusal("INPUT_CONFLICT", 409);
      if (
        call.readVersion.revision !== revision ||
        [...call.entries, ...call.readSet].some(
          (e) => (records.get(e.key)?.revision ?? 0) !== e.expectRevision,
        )
      )
        return refusal("REVISION_CONFLICT", 409);
      const written = call.entries.map((entry) => {
        revision++;
        const value = record(entry.key, entry.value, entry.expectRevision + 1);
        records.set(entry.key, value);
        return value;
      });
      const result = {
        ...facts(),
        requestId: call.requestId,
        records: written,
        result: null,
      };
      accepted.set(receipt, { bytes: init.body!, result });
      if (loss === call.entries[0]?.key) {
        loss = undefined;
        throw Error("accepted but response lost");
      }
      return ok(result);
    }
    if (call.readVersion && call.readVersion.revision !== revision)
      return refusal("REVISION_CONFLICT", 409);
    const q = call.query;
    if (q.kind === "get")
      return ok({
        ...facts(),
        result: { kind: q.kind, record: records.get(q.key) ?? null },
      });
    if (q.kind === "history") {
      const events = (
        q.before === undefined ? [4, 3] : q.before === 3 ? [2, 1] : []
      ).map((rev) => event(q.key, rev));
      return ok({
        ...facts(),
        result: {
          kind: q.kind,
          events,
          next:
            events.length === q.limit ? (q.before === undefined ? 3 : 1) : null,
        },
      });
    }
    if (q.kind === "range") {
      const page = [...records.values()].filter(
        (r) =>
          (q.from === undefined || r.key >= q.from) &&
          (q.to === undefined || r.key < q.to),
      );
      const selected = page.slice(0, q.limit);
      return ok({
        ...facts(),
        result: {
          kind: q.kind,
          records: selected,
          next:
            selected.length === q.limit
              ? selected.at(-1)!.key + (q.descending ? "" : "\0")
              : null,
        },
      });
    }
    return ok({ ...facts(), result: { kind: q.kind, value: records.size } });
  });
  const state = createCloudRecordState({
    key: fx.bindingFor(),
    credentials: {
      lookup: () =>
        credential
          ? fx.entry(clock.now(), {
              id: principal,
              token: fx.tokenFor(principal, "O".repeat(43)),
            })
          : undefined,
    },
    now: clock.now,
    http: createCloudHttp({
      origin: fx.ORIGIN,
      project: fx.PROJECT,
      fetch: net.fetch,
    }),
    namespace,
    context,
    operation: "memory.add",
    requestId: "invocation-1",
    write,
    signal: controller.signal,
    deadline: clock.now() + 60_000,
  });
  return {
    state,
    clock,
    controller,
    calls,
    bytes,
    signals,
    records,
    event,
    commits: () => calls.filter((c) => c.kind === "commit"),
    seed() {
      revision = 4;
      records.set("note/1", record("note/1", "existing"));
    },
    change() {
      revision++;
    },
    noCredential() {
      credential = false;
    },
    restoreCredential() {
      credential = true;
    },
    usePrincipal(id: string) {
      credential = true;
      principal = id;
    },
    deny(code: string) {
      deny = code;
    },
    lose(key: string) {
      loss = key;
    },
    offline() {
      offline = true;
    },
    abortInFlight() {
      abortInFlight = true;
    },
    maxConcurrent: () => maxConcurrent,
  };
}
type Fixture = ReturnType<typeof fixture>;
async function refused(pending: Promise<unknown>, code: string) {
  const error = await pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(ForgeFailure);
  expect((error as ForgeFailure).error.code).toBe(code);
  return error as ForgeFailure;
}

const rows: readonly [string, (f: Fixture) => Promise<void>][] = [
  [
    "Replay refusal keeps the original outcome unknown",
    async (f) => {
      f.lose("note/1");
      const replay = () => f.state.put("note/1", "one", { expectRevision: 0 });
      await refused(replay(), "UNAVAILABLE");
      const original = f.bytes.at(-1);
      f.deny("AUTH_REVOKED");
      expect(await refused(replay(), "AUTH_REVOKED")).toBeInstanceOf(
        CloudRecordRefusal,
      );
      const sent = f.calls.length;
      await refused(f.state.get("missing"), "UNAVAILABLE");
      expect(f.calls).toHaveLength(sent);
      await replay();
      expect(f.bytes.at(-1)).toBe(original);
      expect((await f.state.get("note/1"))?.value).toBe("one");
    },
  ],
  [
    "Pending replay is scoped to its original principal",
    async (f) => {
      f.lose("note/1");
      const replay = () => f.state.put("note/1", "one", { expectRevision: 0 });
      await refused(replay(), "UNAVAILABLE");
      const original = f.bytes.at(-1),
        sent = f.calls.length;
      f.usePrincipal("bbbbbbbbbbbbbbbb");
      expect((await refused(replay(), "UNAVAILABLE")).error.retry).toBe(
        "reconcile_first",
      );
      await refused(f.state.get("missing"), "UNAVAILABLE");
      expect(f.calls).toHaveLength(sent);
      f.usePrincipal("aaaaaaaaaaaaaaaa");
      await replay();
      expect(f.bytes.at(-1)).toBe(original);
      expect((await f.state.get("note/1"))?.value).toBe("one");
    },
  ],
  [
    "First-send decoded server 503 settles pending",
    async (f) => {
      await f.state.get("missing");
      f.deny("UNAVAILABLE");
      const error = await f.state
        .put("note/1", "one", { expectRevision: 0 })
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(CloudRecordRefusal);
      await f.state.get("missing");
      await f.state.put("note/1", "one", { expectRevision: 0 });
      expect(f.commits()).toHaveLength(2);
    },
  ],
  [
    "Read-only provider",
    async () => {
      const f = fixture(false);
      await refused(
        f.state.put("denied", "no", { expectRevision: 0 }),
        "GRANT_REQUIRED",
      );
      expect(f.calls).toHaveLength(0);
    },
  ],
  [
    "Pending replay survives credential loss",
    async (f) => {
      await f.state.put("note/1", "one", { expectRevision: 0 });
      f.lose("note/2");
      const replay = () => f.state.put("note/2", "two", { expectRevision: 0 });
      await refused(replay(), "UNAVAILABLE");
      const before = f.calls.length;
      const original = f.bytes.at(-1);
      f.noCredential();
      await refused(replay(), "AUTH_REQUIRED");
      await refused(f.state.get("missing"), "UNAVAILABLE");
      await refused(
        f.state.put("replacement", "no", { expectRevision: 0 }),
        "UNAVAILABLE",
      );
      expect(f.calls).toHaveLength(before);
      f.restoreCredential();
      await replay();
      expect(f.bytes.at(-1)).toBe(original);
      expect(f.commits().at(-1)!.requestId).toBe(f.commits().at(-2)!.requestId);
      expect((await f.state.get("note/2"))?.value).toBe("two");
      expect(f.records.size).toBe(2);
    },
  ],
  [
    "Invalid JSON parity",
    async (f) => {
      const local = new LocalState(":memory:");
      try {
        const owner = (await local.open(true))!;
        for (const value of [NaN, Infinity, { score: undefined }]) {
          let rejected: unknown;
          try {
            owner.put(namespace, "bad", value, actor, { expectRevision: 0 });
          } catch (error) {
            rejected = error;
          }
          expect(rejected).toBeInstanceOf(ForgeFailure);
          await refused(
            f.state.put("bad", value, { expectRevision: 0 }),
            (rejected as ForgeFailure).error.code,
          );
          expect(f.calls).toHaveLength(0);
        }
        const bypass = spyOn(ownerState, "json").mockImplementation(
          canonicalJson,
        );
        try {
          const mutant = fixture();
          await expect(
            refused(
              mutant.state.put("bad", NaN, { expectRevision: 0 }),
              "INPUT_INVALID",
            ),
          ).rejects.toThrow();
          expect(mutant.records.get("bad")?.value).toBeNull();
        } finally {
          bypass.mockRestore();
        }
      } finally {
        await local.close();
      }
    },
  ],
  [
    "Read plan",
    async (f) => {
      f.seed();
      expect(await f.state.get("missing")).toBeUndefined();
      expect(await f.state.get("note/1")).toEqual(f.records.get("note/1"));
      expect(await f.state.range({ from: "note/", limit: 1 })).toHaveLength(1);
      expect(await f.state.range({ from: "note/1\0", limit: 1 })).toEqual([]);
      expect(await f.state.count("note/")).toBe(1);
      expect(await f.state.max("note/")).toBe(1);
      await f.state.putMany(
        [
          { key: "note/1", value: "new", expectRevision: 1 },
          { key: "note/2", value: "two", expectRevision: 0 },
        ],
        {
          readSet: [
            { key: "missing-2", expectRevision: 0 },
            { key: "note/1", expectRevision: 1 },
          ],
        },
      );
      await f.state.put("note/3", "three", { expectRevision: 0 });
      const [first, second] = f.commits();
      expect(first!.entries).toHaveLength(2);
      expect(
        first!.readSet.map(({ key, expectRevision }) => ({
          key,
          expectRevision,
        })),
      ).toEqual([
        { key: "missing", expectRevision: 0 },
        { key: "note/1", expectRevision: 1 },
        { key: "missing-2", expectRevision: 0 },
      ]);
      expect(
        first!.readSet.every(
          (d) => d.readVersion.revision === 4 && d.namespace === namespace,
        ),
      ).toBe(true);
      expect(second!.readSet).toEqual([]);
      expect(second!.readVersion.revision).toBe(6);
      expect(
        f.calls
          .filter((c) => c.kind === "read")
          .slice(1)
          .every((c) => c.readVersion?.revision === 4),
      ).toBe(true);
      f.change();
      await refused(f.state.get("missing"), "REVISION_CONFLICT");
      await f.state.get("missing");
      expect(f.calls.at(-1)!.readVersion).toBeUndefined();
      f.change();
      await refused(
        f.state.put("note/4", "four", { expectRevision: 0 }),
        "REVISION_CONFLICT",
      );
      await f.state.put("note/4", "four", { expectRevision: 0 });
      expect(f.commits().at(-1)!.requestId).not.toBe(
        f.commits().at(-2)!.requestId,
      );
    },
  ],
  [
    "Sub-requests",
    async (f) => {
      await f.state.put("note/1", "one", { expectRevision: 0 });
      f.lose("note/2");
      const value = { text: "two" };
      await refused(
        f.state.put("note/2", value, { expectRevision: 0 }),
        "UNAVAILABLE",
      );
      value.text = "mutated";
      const before = f.calls.length;
      await refused(f.state.get("missing"), "UNAVAILABLE");
      await refused(
        f.state.put("note/3", "wrong", { expectRevision: 0 }),
        "UNAVAILABLE",
      );
      expect(f.calls).toHaveLength(before);
      f.change();
      await f.state.put("note/2", { text: "two" }, { expectRevision: 0 });
      const commits = f.commits();
      expect(commits[0]!.requestId).not.toBe(commits[1]!.requestId);
      expect(commits[1]).toEqual(commits[2]);
      const wires = f.calls.flatMap((c, i) =>
        c.kind === "commit" ? [f.bytes[i]] : [],
      );
      expect(wires[1]).toBe(wires[2]);
      expect(commits[2]!.entries[0]!.value).toEqual({ text: "two" });
      await f.state.get("note/2");
      expect(f.calls.at(-1)!.readVersion).toBeUndefined();
      await f.state.put("note/3", "three", { expectRevision: 0 });
      expect(f.records.size).toBe(3);
    },
  ],
  [
    "Outage/denied namespace",
    async (f) => {
      f.noCredential();
      await refused(f.state.get("none"), "AUTH_REQUIRED");
      await refused(
        f.state.put("none", "no", { expectRevision: 0 }),
        "AUTH_REQUIRED",
      );
      expect(f.calls).toHaveLength(0);
      for (const fault of ["AUTH_FORBIDDEN", "offline"] as const) {
        const r = fixture();
        await r.state.get("missing");
        if (fault === "offline") r.offline();
        else r.deny(fault);
        await refused(
          r.state.put("none", "no", { expectRevision: 0 }),
          fault === "offline" ? "UNAVAILABLE" : fault,
        );
        expect(r.records.size).toBe(0);
        const sent = r.calls.length;
        await Promise.resolve();
        expect(r.calls).toHaveLength(sent);
      }
    },
  ],
  [
    "Lifetime",
    async (f) => {
      const cachedGet = f.state.get.bind(f.state),
        cachedPut = f.state.put.bind(f.state);
      await cachedGet("missing");
      f.clock.advance(60_000);
      const sent = f.calls.length;
      await refused(cachedGet("missing"), "INVOCATION_TIMEOUT");
      await refused(
        cachedPut("late", "no", { expectRevision: 0 }),
        "INVOCATION_TIMEOUT",
      );
      expect(f.calls).toHaveLength(sent);
      const r = fixture();
      await r.state.get("missing");
      r.controller.abort();
      expect(r.signals[0]!.aborted).toBe(true);
      await refused(r.state.get("missing"), "INVOCATION_CANCELLED");
      await refused(
        r.state.put("late", "no", { expectRevision: 0 }),
        "INVOCATION_CANCELLED",
      );
      const inFlight = fixture();
      await inFlight.state.get("missing");
      inFlight.abortInFlight();
      await refused(
        inFlight.state.put("uncertain", "no", { expectRevision: 0 }),
        "UNAVAILABLE",
      );
      expect(inFlight.signals.at(-1)!.aborted).toBe(true);
    },
  ],
];
for (const [name, run] of rows) test(name, () => run(fixture()));

test("read plans serialize access and map history revision bounds to sequence cursors", async () => {
  const f = fixture();
  f.seed();
  await Promise.all([
    f.state.get("missing"),
    f.state.count("note/"),
    f.state.max("note/"),
  ]);
  expect(f.maxConcurrent()).toBe(1);
  expect(await f.state.history({ key: "note/1", limit: 2, before: 3 })).toEqual(
    [2, 1].map((revision) => f.event("note/1", revision)),
  );
  expect(
    f.calls
      .filter(
        (c): c is StateReadRequest =>
          c.kind === "read" && c.query.kind === "history",
      )
      .map((c) => c.query),
  ).toEqual([
    { kind: "history", key: "note/1", limit: 2 },
    { kind: "history", key: "note/1", limit: 2, before: 3 },
  ]);
  expect(await f.state.history({ key: "note/1", limit: 2, before: 1 })).toEqual(
    [],
  );
  expect(f.calls.at(-1)).toMatchObject({
    kind: "read",
    query: { kind: "history", key: "note/1", limit: 2, before: 1 },
  });
});
