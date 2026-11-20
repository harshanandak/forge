import { expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { format } from "node:util";
import {
  LANE_BROWSER,
  LANE_STATE_PREFIX,
} from "../../cloud/src/auth/lane-browser.ts";
import { sha256 } from "../../cloud/src/tokens.ts";
import { Project } from "../../cloud/src/project.ts";
import {
  OLD_SCHEMA,
  OLD_LANE_SCHEMA,
  badOpener,
  setupCalls,
} from "./old-schema.ts";
import { createWorker } from "../../cloud/src/worker.ts";
import { stockIngress } from "./stock-ingress.fixture.ts";
import { durableStore } from "../../cloud/src/store.ts";
import { StateOwner } from "../../src/core/state/index.ts";
import type { ResultEnvelope } from "../../src/generated/types.ts";
import { exitCode } from "../../src/surface/result.ts";
import ResumeInput from "../../src/blocks/work/schemas/lane-resume.input.json" with { type: "json" };
import { validateWithSchema } from "../../src/contract/schema.ts";
import {
  LANE_APPROVALS,
  laneApprovalStatus,
  type LaneApproval,
} from "../../cloud/src/lane-approval.ts";

if (!("timingSafeEqual" in crypto.subtle))
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    value: crypto.timingSafeEqual.bind(crypto),
  });
import { browserStorage } from "./browser-storage.fixture.ts";
import type { DeviceBrowserOptions } from "../../cloud/src/auth/device-browser.ts";
import type {
  IdentityClaims,
  IdentityResult,
} from "../../src/ports/identity.ts";
import { testIdentityVerifier } from "../contract/lib/identity-verifier.ts";
await mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
const { createConfiguredWorker } =
  await import("../../cloud/src/adapters/workers-oauth/compose.ts");
const now = 1_800_000_000_000;
const actor = { kind: "agent", id: "fixture" } as const;
const running = {
  version: 1,
  incarnation: "history",
  epoch: 4,
  resumeAllEpoch: 0,
  stopAll: null,
};
const call = (
  op: string,
  input: object,
  requestId = "lane-1",
  more: object = {},
) => ({ requestId, op, input, context: { actor }, ...more });

// All tables use this fixture: real token admission, Worker routing and project storage.
async function fixture(
  projectName = "p",
  session: string | null = "s1",
  browser: DeviceBrowserOptions = {},
  ingress?: ReturnType<typeof stockIngress>,
) {
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const db = new Database(":memory:");
  let writes = 0;
  const calls: string[] = [];
  const { storage, values } = browserStorage(db, (sql) => {
    calls.push(sql);
    if (/^\s*(INSERT|UPDATE|DELETE|CREATE)\b/i.test(sql)) writes++;
  });
  const env = {
    FORGE_CLOUD_PROJECT: projectName,
    FORGE_CLOUD_ID_PREFIX: "forge",
    DEVICE_LOGIN_HMAC_KEY: Buffer.alloc(32, 7).toString("base64url"),
    CLERK_REDIRECT_URI: "https://w.example/callback",
    CLERK_ISSUER: "https://identity.example",
    CLERK_CLIENT_ID: "forge-cloud",
    FORGE_OWNER_SUBJECT: "user_Owner1",
    FORGE_API_RESOURCE: "https://w.example",
    OAUTH_TIMEOUT_MS: "5000",
  };
  let project = new Project({ storage }, env, browser);
  const reached: string[] = [];
  const bindings = {
    ...env,
    PROJECTS: {
      idFromName: (id: string) => id,
      get: (id: unknown) => {
        reached.push(String(id));
        return project;
      },
    },
  };
  const admit = async (device: string, tokenSession = session) => {
    const admitted = await project.fetch(
      new Request(`https://w.example/p/${projectName}/devices`, {
        method: "POST",
        body: JSON.stringify({
          device,
          ...(tokenSession === null ? {} : { session: tokenSession }),
          ttlMs: 86_400_000,
        }),
      }),
    );
    return ((await admitted.json()) as { value: { token: string } }).value
      .token;
  };
  const token = await admit("laptop");
  const owner = new StateOwner(durableStore(storage), { now: () => now });
  const put = (key: string, value: unknown) =>
    owner.put("forge/work", key, value, actor, { expectRevision: 0 });
  for (const id of ["work-7", "work-8"])
    put(`issue:${id}`, {
      id,
      title: id,
      status: "open",
      labels: [],
      dependsOn: [],
      createdAt: new Date(now).toISOString(),
    });
  const snapshot = () =>
    JSON.stringify([
      ...[
        "state_records",
        "state_events",
        "state_leases",
        "state_requests",
        "domain_cloud_command_receipts",
        LANE_APPROVALS,
      ].map((name) => db.query(`SELECT * FROM ${name}`).all()),
      [...values],
    ]);
  return {
    db,
    calls,
    reopen: (Constructor = Project) => {
      calls.length = 0;
      project = new Constructor({ storage }, env, browser);
    },
    schema: () =>
      JSON.stringify(
        [
          "sqlite_schema",
          "state_migrations",
          "state_domains",
          "domain_cloud_pragma",
        ].map((table) => db.query(`SELECT * FROM ${table}`).all()),
      ),
    writes: () => writes,
    env,
    reached,
    dump: (cursor?: string) => {
      const url = new URL(`https://w.example/p/${projectName}/dump`);
      if (cursor !== undefined) url.searchParams.set("cursor", cursor);
      return project.fetch(new Request(url.href));
    },
    browser: async (
      path: string,
      body?: string,
      headers: Record<string, string> = {},
      production = false,
    ) => {
      const request = new Request(`https://w.example${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...headers,
        },
        ...(body === undefined ? {} : { body }),
      });
      await ingress?.observe(request, bindings);
      const response = await (
        production ? createConfiguredWorker() : createWorker()
      ).fetch(request, bindings);
      return {
        status: response.status,
        headers: response.headers,
        text: await response.text(),
      };
    },
    owner,
    put,
    clock,
    admit,
    snapshot,
    close: () => {
      db.close();
      clock.mockRestore();
    },
    send: async (body: unknown, route = projectName, headers = {}) => {
      const response = await createWorker().fetch(
        new Request(`https://w.example/p/${route}/command`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, ...headers },
          body: JSON.stringify(body),
        }),
        {
          FORGE_CLOUD_PROJECT: projectName,
          PROJECTS: { idFromName: (id) => id, get: () => project },
        },
      );
      const envelope = (await response.json()) as ResultEnvelope;
      return {
        status: response.status,
        envelope,
        result: envelope.ok ? envelope.result : undefined,
        verdict: [
          envelope.status ?? "FAIL",
          envelope.ok ? "OK" : envelope.error.code,
          exitCode(envelope),
        ],
      };
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function expectRefusalOnly(
  before: string,
  after: string,
  reply: ResultEnvelope,
) {
  if (reply.ok) throw new Error("Expected a refusal");
  const prior = JSON.parse(before) as unknown[];
  const current = JSON.parse(after) as unknown[];
  const oldRows = prior[4] as { request_id: string }[];
  const newRows = current[4] as {
    request_id: string;
    outcome: string;
    result: string;
  }[];
  const added = newRows.filter(
    (row) => !oldRows.some((old) => old.request_id === row.request_id),
  );
  expect(added).toHaveLength(1);
  expect(added[0]!.outcome).toBe("refused");
  expect(JSON.parse(added[0]!.result)).toEqual(reply.error);
  current[4] = newRows.filter((row) => row !== added[0]);
  expect(JSON.stringify(current)).toBe(before);
}
const control = (f: Fixture, id?: string) =>
  f.send(call("lane.control", id === undefined ? {} : { id }));
const stopped = (epoch: number, scope: string) => ({
  incarnation: "history",
  epoch,
  stopped: true,
  scope,
  since: new Date(now).toISOString(),
});

const dispatchIssue = { id: "work-7" };
const dispatchLeaseIssue = { id: "forge-7" };
const dispatchInput = {
  ...dispatchIssue,
  dispatchId: "dispatch-proof",
  incarnation: running.incarnation,
  epoch: running.epoch,
};
const dispatchKey = "lane-dispatch:work-7:dispatch-proof";
const executor = (id = "s1") => ({
  actor,
  session: { id },
});
const dispatchCall = (
  requestId = "dispatch-1",
  input = dispatchInput,
  context = executor(),
) => call("lane.dispatch", input, requestId, { context });
const claimDispatch = (f: Fixture, id = "s1", headers = {}) =>
  f.send(
    call(
      "issue.claim",
      { ...dispatchLeaseIssue, ttlSeconds: 60 },
      `claim-${id}`,
      {
        context: { actor, session: { id } },
      },
    ),
    "p",
    headers,
  );
const dispatchState = (f: Fixture) =>
  ["state_records", "state_events"].map((table) =>
    f.db
      .query(
        `SELECT key FROM ${table} WHERE namespace='forge/work' AND key LIKE 'lane-dispatch:%'`,
      )
      .values()
      .flat(),
  );
const expectOneDispatch = (f: Fixture, result: unknown) => {
  expect(dispatchState(f)).toEqual([[dispatchKey], [dispatchKey]]);
  expect(f.owner.get("forge/work", dispatchKey)).toMatchObject({
    revision: 1,
    value: result,
  });
  const event = f.db
    .query<{ body: string }, [string]>(
      "SELECT body FROM state_events WHERE namespace='forge/work' AND key=?",
    )
    .get(dispatchKey)!;
  expect(JSON.parse(event.body)).toMatchObject({
    type: "forge/work:record.updated@1",
    revision: 1,
    data: result,
  });
};
const liveDispatch = async () => {
  const f = await fixture();
  f.put("lane-control:global", running);
  return f;
};

test.each([{ all: true }, dispatchIssue])(
  "dispatch refuses the current stopped epoch even with a valid lease, scope %j",
  async (scope) => {
    const f = await liveDispatch();
    try {
      expect((await claimDispatch(f)).verdict).toEqual(["OK", "OK", 0]);
      const stop = await f.send(call("lane.stop", scope, "dispatch-stop"));
      expect(stop.result).toMatchObject({ stopped: true, epoch: 5 });
      const reply = await f.send(
        dispatchCall("stopped", { ...dispatchInput, epoch: 5 }),
      );
      expect(reply.verdict).toEqual(["FAIL", "INPUT_CONFLICT", 4]);
      expect(reply.envelope.ok ? "" : reply.envelope.error.message).toMatch(
        /stopped/i,
      );
      expect(dispatchState(f)).toEqual([[], []]);
    } finally {
      f.close();
    }
  },
  10_000,
);

test("approved resume permits one dispatch with fresh control and records its event", async () => {
  const f = await resumeFixture("all");
  try {
    expect((await claimDispatch(f)).verdict).toEqual(["OK", "OK", 0]);
    expect((await f.send(f.resume)).verdict).toEqual(["OK", "OK", 0]);
    const fresh = await control(f, dispatchIssue.id);
    expect(fresh.result).toEqual({
      incarnation: "history",
      epoch: 6,
      stopped: false,
    });
    const reply = await f.send(
      dispatchCall("resumed", { ...dispatchInput, epoch: 6 }),
    );
    expect(reply.verdict).toEqual(["OK", "OK", 0]);
    expect(reply.result).toEqual({
      ...dispatchInput,
      epoch: 6,
      holder: { device: "laptop", session: "s1" },
      leaseGeneration: 1,
      recordedAt: new Date(now).toISOString(),
      kind: "recorded-intent",
    });
    expectOneDispatch(f, reply.result);
  } finally {
    f.close();
  }
}, 10_000);

test("two sessions race for the claim and only the current holder can dispatch", async () => {
  const f = await liveDispatch();
  try {
    const other = { authorization: `Bearer ${await f.admit("desktop", "s2")}` };
    const clients = [
      ["s1", {}],
      ["s2", other],
    ] as const;
    const claims = await Promise.all(
      clients.map(([id, headers]) => claimDispatch(f, id, headers)),
    );
    const winner = claims.findIndex((reply) => reply.envelope.ok);
    expect(winner).toBeGreaterThanOrEqual(0);
    expect(claims[1 - winner]!.verdict).toEqual(["FAIL", "LEASE_HELD", 4]);
    const replies = await Promise.all(
      clients.map(([id, headers]) =>
        f.send(
          dispatchCall(`dispatch-${id}`, dispatchInput, executor(id)),
          "p",
          headers,
        ),
      ),
    );
    expect(replies[winner]!.verdict).toEqual(["OK", "OK", 0]);
    expect(replies[1 - winner]!.verdict).toEqual(["FAIL", "LEASE_NOT_HELD", 4]);
    expectOneDispatch(f, replies[winner]!.result);
  } finally {
    f.close();
  }
}, 10_000);

test("a device-only token cannot dispatch as a live lease holder on the same device", async () => {
  const f = await liveDispatch();
  try {
    expect((await claimDispatch(f)).verdict).toEqual(["OK", "OK", 0]);
    const token = await f.admit("laptop", null);
    const before = f.snapshot();
    const reply = await f.send(dispatchCall(), "p", {
      authorization: `Bearer ${token}`,
    });
    expect(reply.status).toBe(403);
    expect(reply.verdict).toEqual(["FAIL", "AUTH_DEVICE_MISMATCH", 1]);
    expect(dispatchState(f)).toEqual([[], []]);
    expect(f.snapshot()).toBe(before);
  } finally {
    f.close();
  }
}, 10_000);

test("distinct request IDs for one live dispatch both return its single durable intent", async () => {
  const f = await liveDispatch();
  try {
    expect((await claimDispatch(f)).verdict).toEqual(["OK", "OK", 0]);
    const replies = await Promise.all(
      ["duplicate-1", "duplicate-2"].map((id) => f.send(dispatchCall(id))),
    );
    expect(replies.map(({ verdict }) => verdict)).toEqual([
      ["OK", "OK", 0],
      ["OK", "OK", 0],
    ]);
    expect(replies[0]!.result).toEqual(replies[1]!.result);
    expectOneDispatch(f, replies[0]!.result);
    const before = f.snapshot();
    expect((await f.send(dispatchCall("duplicate-2"))).result).toEqual(
      replies[0]!.result,
    );
    expect(f.snapshot()).toBe(before);
  } finally {
    f.close();
  }
}, 10_000);

test("a request that reconciles an intent is bound to that input", async () => {
  const f = await liveDispatch();
  try {
    expect((await claimDispatch(f)).verdict).toEqual(["OK", "OK", 0]);
    const first = await f.send(dispatchCall("request-a"));
    expect(first.verdict).toEqual(["OK", "OK", 0]);
    const reconciled = await f.send(dispatchCall("request-b"));
    expect(reconciled.verdict).toEqual(["OK", "OK", 0]);
    expect(reconciled.result).toEqual(first.result);
    const snapshot = f.snapshot();
    const reused = await f.send(
      dispatchCall("request-b", { ...dispatchInput, dispatchId: "dispatch-y" }),
    );
    expect(reused.verdict).toEqual(["FAIL", "INPUT_CONFLICT", 4]);
    const replay = await f.send(dispatchCall("request-b"));
    expect(replay.verdict).toEqual(["OK", "OK", 0]);
    expect(replay.result).toEqual(first.result);
    expect(f.snapshot()).toBe(snapshot);
    expectOneDispatch(f, first.result);
  } finally {
    f.close();
  }
}, 10_000);

test("takeover rejects reuse of the old dispatch ID and replay by the old holder", async () => {
  const f = await liveDispatch();
  try {
    expect((await claimDispatch(f)).verdict).toEqual(["OK", "OK", 0]);
    const first = await f.send(dispatchCall());
    expect(first.verdict).toEqual(["OK", "OK", 0]);
    const release = call("issue.release", dispatchLeaseIssue, "release", {
      context: { ...executor(), leaseGeneration: 1 },
    });
    expect((await f.send(release)).verdict).toEqual(["OK", "OK", 0]);
    const other = { authorization: `Bearer ${await f.admit("desktop", "s2")}` };
    const claim = await claimDispatch(f, "s2", other);
    expect(claim.result).toMatchObject({ generation: 2 });
    expect((await f.send(dispatchCall())).verdict).toEqual([
      "FAIL",
      "LEASE_STALE",
      4,
    ]);
    const reuse = await f.send(
      dispatchCall("takeover", dispatchInput, executor("s2")),
      "p",
      other,
    );
    expect(reuse.verdict).toEqual(["FAIL", "INPUT_CONFLICT", 4]);
    expectOneDispatch(f, first.result);
  } finally {
    f.close();
  }
}, 10_000);

test("stop after dispatch refuses both a receipt replay and a new request for the same intent", async () => {
  const f = await liveDispatch();
  try {
    expect((await claimDispatch(f)).verdict).toEqual(["OK", "OK", 0]);
    const first = await f.send(dispatchCall());
    expect(first.verdict).toEqual(["OK", "OK", 0]);
    const stop = await f.send(call("lane.stop", { all: true }, "stop"));
    expect(stop.result).toMatchObject({ stopped: true, epoch: 5 });
    const refused = await Promise.all([
      f.send(dispatchCall()),
      f.send(dispatchCall("same-intent", { ...dispatchInput, epoch: 5 })),
    ]);
    for (const reply of refused) {
      expect(reply.verdict).toEqual(["FAIL", "INPUT_CONFLICT", 4]);
      expect(reply.envelope.ok ? "" : reply.envelope.error.message).toMatch(
        /stopped/i,
      );
    }
    expectOneDispatch(f, first.result);
  } finally {
    f.close();
  }
}, 10_000);

test("a dispatch from a previous control incarnation remains history", async () => {
  const f = await liveDispatch();
  try {
    expect((await claimDispatch(f)).verdict).toEqual(["OK", "OK", 0]);
    const first = await f.send(dispatchCall());
    expect(first.verdict).toEqual(["OK", "OK", 0]);
    f.owner.put(
      "forge/work",
      "lane-control:global",
      {
        ...running,
        incarnation: "restored",
      },
      actor,
      { expectRevision: 1 },
    );
    const replies = await Promise.all([
      f.send(dispatchCall()),
      f.send(
        dispatchCall("restored", { ...dispatchInput, incarnation: "restored" }),
      ),
    ]);
    for (const reply of replies)
      expect(reply.verdict).toEqual(["FAIL", "INPUT_CONFLICT", 4]);
    expectOneDispatch(f, first.result);
  } finally {
    f.close();
  }
}, 10_000);

test.each(["state_events", "domain_cloud_command_receipts"])(
  "failure writing %s after inserting the intent rolls back the dispatch",
  async (table) => {
    const f = await liveDispatch();
    try {
      expect((await claimDispatch(f)).verdict).toEqual(["OK", "OK", 0]);
      f.db.run(
        `CREATE TRIGGER refuse_dispatch BEFORE INSERT ON ${table}
        WHEN EXISTS (SELECT 1 FROM state_records WHERE namespace='forge/work' AND key='${dispatchKey}')
        BEGIN SELECT RAISE(ABORT, 'injected SQLITE_FULL'); END`,
      );
      const before = f.snapshot();
      const reply = await f.send(dispatchCall());
      expect(reply.status).toBe(503);
      expect(reply.verdict).toEqual(["FAIL", "STORAGE_LIMIT_EXCEEDED", 1]);
      expect(f.snapshot()).toBe(before);
      expect(dispatchState(f)).toEqual([[], []]);
    } finally {
      f.close();
    }
  },
  10_000,
);

test("a lost dispatch response reconciles from the durable key after the receipt is gone", async () => {
  const f = await liveDispatch();
  try {
    expect((await claimDispatch(f)).verdict).toEqual(["OK", "OK", 0]);
    await f.send(dispatchCall());
    const prior = f.owner.get("forge/work", dispatchKey)?.value;
    expect(prior).toMatchObject({ kind: "recorded-intent" });
    f.db.run("DELETE FROM domain_cloud_command_receipts");
    f.reopen();
    const retry = await f.send(dispatchCall("reconcile"));
    expect(retry.verdict).toEqual(["OK", "OK", 0]);
    expect(retry.result).toEqual(prior);
    expectOneDispatch(f, prior);
  } finally {
    f.close();
  }
}, 10_000);

test.each([
  ["missing control", "UNAVAILABLE", 1],
  ["corrupt control", "UNAVAILABLE", 1],
  ["stale epoch", "INPUT_CONFLICT", 4],
  ["stale incarnation", "INPUT_CONFLICT", 4],
  ["revoked token", "AUTH_REVOKED", 1],
  ["dry run", "UNAVAILABLE", 1],
  ["missing lease", "LEASE_NOT_HELD", 4],
  ["expired lease", "LEASE_EXPIRED", 4],
  ["released lease", "LEASE_NOT_HELD", 4],
] as const)(
  "dispatch fails closed with %s",
  async (mode, code, exit) => {
    const f = await fixture();
    try {
      if (mode !== "missing control") {
        f.put("lane-control:global", running);
        if (mode === "corrupt control")
          f.put("lane-control:work-7", { stoppedAt: null });
      }
      if (mode !== "missing lease")
        expect((await claimDispatch(f)).verdict).toEqual(["OK", "OK", 0]);
      if (mode === "expired lease") f.clock.mockReturnValue(now + 60_000);
      if (mode === "released lease")
        expect(
          (
            await f.send(
              call("issue.release", dispatchLeaseIssue, "release", {
                context: { ...executor(), leaseGeneration: 1 },
              }),
            )
          ).verdict,
        ).toEqual(["OK", "OK", 0]);
      if (mode === "revoked token")
        f.db.run("UPDATE domain_cloud_tokens SET revoked_at=?", [now]);
      const reply = await f.send({
        ...dispatchCall("refuse", {
          ...dispatchInput,
          epoch: mode === "stale epoch" ? 3 : 4,
          incarnation: mode === "stale incarnation" ? "older" : "history",
        }),
        ...(mode === "dry run" ? { dryRun: true } : {}),
      });
      expect(reply.verdict).toEqual(["FAIL", code, exit]);
      expect(dispatchState(f)).toEqual([[], []]);
    } finally {
      f.close();
    }
  },
  10_000,
);

test.each([undefined, "work-7"])(
  "lane.control reads running or unavailable without writing, scope %s",
  async (id) => {
    const f = await fixture();
    try {
      for (const initialized of [false, true]) {
        if (initialized) f.put("lane-control:global", running);
        const before = f.snapshot();
        const reply = await control(f, id);
        expect(reply.verdict).toEqual(
          initialized ? ["OK", "OK", 0] : ["FAIL", "UNAVAILABLE", 1],
        );
        if (initialized)
          expect(reply.result).toEqual({
            incarnation: "history",
            epoch: 4,
            stopped: false,
          });
        expect(f.snapshot()).toBe(before);
      }
    } finally {
      f.close();
    }
  },
  10_000,
);

const refusals: [string, string, object, object, string, number][] = [
  ["unknown issue", "lane.stop", { id: "work-99" }, {}, "NOT_FOUND", 3],
  ...["other-7", "7", "work-07"].map(
    (id): [string, string, object, object, string, number] => [
      `noncanonical ${id}`,
      "lane.stop",
      { id },
      {},
      "INPUT_INVALID",
      6,
    ],
  ),
  [
    "extra key",
    "lane.stop",
    { all: true, key: "other" },
    {},
    "INPUT_INVALID",
    6,
  ],
  [
    "both scopes",
    "lane.stop",
    { all: true, id: "work-7" },
    {},
    "INPUT_INVALID",
    6,
  ],
  ["missing scope", "lane.stop", {}, {}, "INPUT_INVALID", 6],
  ["read extra key", "lane.control", { key: "other" }, {}, "INPUT_INVALID", 6],
  ["read malformed id", "lane.control", { id: "7" }, {}, "INPUT_INVALID", 6],
  [
    "read foreign prefix",
    "lane.control",
    { id: "other-7" },
    {},
    "INPUT_INVALID",
    6,
  ],
  [
    "resume foreign prefix",
    "lane.resume",
    { id: "other-7" },
    {},
    "INPUT_INVALID",
    6,
  ],
  [
    "project context",
    "lane.stop",
    { all: true },
    { project: { id: "other" } },
    "INPUT_INVALID",
    6,
  ],
  [
    "device",
    "lane.stop",
    { all: true },
    { device: { id: "other" } },
    "AUTH_DEVICE_MISMATCH",
    1,
  ],
  [
    "session device",
    "lane.stop",
    { all: true },
    { session: { id: "s1", device: "other" } },
    "AUTH_DEVICE_MISMATCH",
    1,
  ],
  [
    "session",
    "lane.stop",
    { all: true },
    { session: { id: "other" } },
    "AUTH_DEVICE_MISMATCH",
    1,
  ],
];
test.each(refusals)(
  "%s refuses without a record, event or receipt",
  async (_name, op, input, context, code, exit) => {
    const f = await fixture();
    try {
      f.put("lane-control:global", running);
      const before = f.snapshot();
      const reply = await f.send(
        call(op, input, "refused", { context: { actor, ...context } }),
      );
      expect(reply.verdict).toEqual(["FAIL", code, exit]);
      expect(f.snapshot()).toBe(before);
    } finally {
      f.close();
    }
  },
  10_000,
);

test.each([
  "one",
  "all",
  "dry one",
  "dry all",
  "foreign route",
  "device token",
])(
  "lane.stop %s through the authenticated command route",
  async (mode) => {
    const f = await fixture("p", mode === "device token" ? null : "s1");
    const other = mode === "foreign route" ? await fixture("other") : undefined;
    try {
      const all = mode.endsWith("all");
      const dryRun = mode.startsWith("dry");
      if (!all) f.put("lane-control:global", running);
      const before = f.snapshot();
      const otherBefore = other?.snapshot() ?? "";
      const unchanged = f.owner.get("forge/work", "issue:work-8");
      const otherControl = f.owner.get("forge/work", "lane-control:work-8");
      const request = call(
        "lane.stop",
        all ? { all: true } : { id: "work-7" },
        "stop",
        { dryRun },
      );
      const reply = await f.send(request, other === undefined ? "p" : "other");
      if (other !== undefined) {
        expect(reply.verdict).toEqual(["FAIL", "AUTH_FORBIDDEN", 1]);
        expect(f.snapshot()).toBe(before);
        expect(other.snapshot()).toBe(otherBefore);
        return;
      }
      expect(reply.verdict).toEqual(["OK", "OK", 0]);
      expect(reply.result).toMatchObject({
        epoch: all ? 1 : 5,
        stopped: true,
        scope: all ? "all" : "issue",
      });
      expect(f.owner.get("forge/work", "issue:work-8")).toEqual(unchanged);
      expect(f.owner.get("forge/work", "lane-control:work-8")).toEqual(
        otherControl,
      );
      if (dryRun) {
        expect(f.snapshot()).toBe(before);
        return;
      }
      const after = f.snapshot();
      expect((await f.send(request)).envelope).toEqual(reply.envelope);
      expect(f.snapshot()).toBe(after);
      expect(
        (
          await f.send({
            ...request,
            input: all ? { id: "work-7" } : { all: true },
          })
        ).verdict,
      ).toEqual(["FAIL", "INPUT_CONFLICT", 4]);
      expect(f.snapshot()).toBe(after);
      expect(
        (await f.send({ ...request, requestId: "new-stop" })).result,
      ).toMatchObject({ epoch: all ? 2 : 6 });
      const audits = f.db
        .query(
          "SELECT body FROM state_records WHERE key LIKE 'lane-control:audit:%'",
        )
        .all() as { body: string }[];
      expect(audits).toHaveLength(2);
      const auditSession =
        mode === "device token"
          ? (
              f.db.query("SELECT id FROM domain_cloud_tokens").get() as {
                id: string;
              }
            ).id
          : "s1";
      for (const audit of audits)
        expect(JSON.parse(audit.body)).toMatchObject({
          value: { device: "laptop", session: auditSession },
        });
      expect((await control(f)).result).toMatchObject({ stopped: all });
      expect((await control(f, "work-7")).result).toMatchObject({
        stopped: true,
      });
      if (!all)
        expect((await control(f, "work-8")).result).toMatchObject({
          stopped: false,
        });
      if (!all) expect(reply.result).toEqual(stopped(5, "issue"));
    } finally {
      other?.close();
      f.close();
    }
  },
  10_000,
);

test.each([
  { op: "lane.control", dryRun: false },
  { op: "lane.stop", dryRun: false },
  { op: "lane.stop", dryRun: true },
  { op: "lane.resume", dryRun: false },
])(
  "a device-only token cannot claim a session for %j",
  async ({ op, dryRun }) => {
    const f = await fixture("p", null);
    try {
      f.put("lane-control:global", running);
      const before = f.snapshot();
      const reply = await f.send(
        call(op, { id: "work-7" }, "claimed-session", {
          dryRun,
          context: { actor, session: { id: "untrusted-session" } },
        }),
      );
      expect(reply.verdict).toEqual(["FAIL", "AUTH_DEVICE_MISMATCH", 1]);
      expect(f.snapshot()).toBe(before);
    } finally {
      f.close();
    }
  },
  10_000,
);

test.each([
  "issue",
  "all",
  "all issue stops",
  "device token",
  "hostile headers",
])(
  "lane.resume creates one exact pending request for %s without changing control",
  async (mode) => {
    const f = await fixture("p", mode === "device token" ? null : "s1");
    try {
      const scope = mode.startsWith("all") ? { all: true } : { id: "work-7" };
      await f.send(call("lane.stop", { all: true }, "initialize"));
      // An issue resume cannot clear a project-wide stop.
      if (mode !== "all") {
        f.owner.put("forge/work", "lane-control:global", running, actor, {
          expectRevision: 1,
        });
        await f.send(call("lane.stop", { id: "work-7" }, "stop-issue"));
      }
      const before = [
        f.owner.get("forge/work", "lane-control:global"),
        f.owner.get("forge/work", "lane-control:work-7"),
      ];
      const request = call("lane.resume", scope, "ask");
      const headers =
        mode === "hostile headers"
          ? {
              Host: "evil.example",
              Origin: "https://evil.example",
              "X-Forwarded-Host": "evil.example",
            }
          : {};
      const reply = await f.send(request, "p", headers);
      expect(reply.verdict).toEqual(["FAIL", "APPROVAL_REQUIRED", 1]);
      expect(reply.status).toBe(409);
      expect(reply.envelope).toMatchObject({
        ok: false,
        status: "FAIL",
        result: {
          scope,
          expiresAt: new Date(now + 600_000).toISOString(),
        },
      });
      const pending = (
        reply.envelope as unknown as {
          result: { request: string };
        }
      ).result;
      expect(pending.request).toMatch(/^[a-f0-9-]+$/);
      expect(pending).not.toHaveProperty("url");
      const after = f.snapshot();
      expect((await f.send(request)).envelope).toEqual(reply.envelope);
      expect(f.snapshot()).toBe(after);
      expect(
        (
          await f.send({
            ...request,
            input: mode.startsWith("all") ? { id: "work-7" } : { all: true },
          })
        ).verdict,
      ).toEqual(["FAIL", "INPUT_CONFLICT", 4]);
      expect(f.snapshot()).toBe(after);
      expect([
        f.owner.get("forge/work", "lane-control:global"),
        f.owner.get("forge/work", "lane-control:work-7"),
      ]).toEqual(before);
    } finally {
      f.close();
    }
  },
  10_000,
);

test.each(["running", "global stop", "foreign route", "device cap", "expired"])(
  "lane.resume refuses or expires safely for %s",
  async (mode) => {
    const f = await fixture();
    try {
      f.put("lane-control:global", running);
      if (mode !== "running")
        await f.send(call("lane.stop", { all: true }, "stop"));
      const scope = mode === "global stop" ? { id: "work-7" } : { all: true };
      if (mode === "device cap" || mode === "expired")
        for (let i = 0; i < 4; i++) {
          const ask = await f.send(call("lane.resume", scope, `ask-${i}`));
          expect(ask.verdict).toEqual(["FAIL", "APPROVAL_REQUIRED", 1]);
          expect(ask.status).toBe(409);
        }
      if (mode === "expired") f.clock.mockReturnValue(now + 600_000);
      const before = f.snapshot();
      const reply = await f.send(
        call("lane.resume", scope, "ask-final"),
        mode === "foreign route" ? "other" : "p",
      );
      const code =
        mode === "device cap"
          ? "UNAVAILABLE"
          : mode === "foreign route"
            ? "AUTH_FORBIDDEN"
            : mode === "expired"
              ? "APPROVAL_REQUIRED"
              : "INPUT_CONFLICT";
      expect(reply.verdict).toEqual([
        "FAIL",
        code,
        code === "INPUT_CONFLICT" ? 4 : 1,
      ]);
      if (code === "APPROVAL_REQUIRED") expect(reply.status).toBe(409);
      if (mode === "device cap")
        expectRefusalOnly(before, f.snapshot(), reply.envelope);
      else if (mode !== "expired") expect(f.snapshot()).toBe(before);
      if (mode === "expired")
        expect(reply.envelope).toMatchObject({
          result: { expiresAt: new Date(now + 1_200_000).toISOString() },
        });
    } finally {
      f.close();
    }
  },
  10_000,
);

test.each(["audit", "receipt", "approval", "approval receipt"])(
  "a failed %s rolls back control, events and receipt together",
  async (where) => {
    const f = await fixture();
    try {
      f.put("lane-control:global", running);
      if (where.startsWith("approval"))
        await f.send(call("lane.stop", { all: true }, "stop"));
      const before = f.snapshot();
      const target =
        where === "audit"
          ? "state_records WHEN NEW.key LIKE 'lane-control:audit:%'"
          : where === "approval"
            ? LANE_APPROVALS
            : "domain_cloud_command_receipts";
      f.db.run(
        `CREATE TRIGGER refuse_write BEFORE INSERT ON ${target} BEGIN SELECT RAISE(ABORT, 'injected write failure'); END`,
      );
      const reply = await f.send(
        where.startsWith("approval")
          ? call("lane.resume", { all: true })
          : call("lane.stop", { id: "work-7" }),
      );
      expect(reply.envelope.ok).toBe(false);
      if (where === "audit")
        expectRefusalOnly(before, f.snapshot(), reply.envelope);
      else expect(f.snapshot()).toBe(before);
    } finally {
      f.close();
    }
  },
  10_000,
);

test.each(["project cap", "expired", "epoch", "incarnation", "retention"])(
  "pending approval lifecycle: %s",
  async (mode) => {
    const f = await fixture();
    try {
      await f.send(call("lane.stop", { all: true }, "stop"));
      const reply = await f.send(call("lane.resume", { all: true }, "ask"));
      expect(reply.verdict).toEqual(["FAIL", "APPROVAL_REQUIRED", 1]);
      expect(reply.status).toBe(409);
      const rows = () =>
        (
          JSON.parse(
            String(
              (
                f.db
                  .query(`SELECT state FROM ${LANE_APPROVALS} WHERE id=1`)
                  .get() as { state: string }
              ).state,
            ),
          ) as {
            requests: LaneApproval[];
          }
        ).requests;
      const row = rows()[0]!;
      expect(row).toMatchObject({
        project: "p",
        scope: { all: true },
        device: "laptop",
        session: "s1",
        epoch: 1,
      });
      expect(typeof row.policyIdentity).toBe("string");
      expect(typeof row.token).toBe("string");
      if (mode === "project cap") {
        for (let i = 1; i < 64; i++) {
          const token = await f.admit(`device-${Math.floor(i / 4)}`);
          const ask = await f.send(
            call("lane.resume", { all: true }, `ask-${i}`),
            "p",
            { authorization: `Bearer ${token}` },
          );
          expect(ask.verdict).toEqual(["FAIL", "APPROVAL_REQUIRED", 1]);
          expect(ask.status).toBe(409);
        }
        const token = await f.admit("overflow");
        const admitted = f.snapshot();
        const overflow = await f.send(
          call("lane.resume", { all: true }, "overflow"),
          "p",
          { authorization: `Bearer ${token}` },
        );
        expect(overflow.verdict).toEqual(["FAIL", "UNAVAILABLE", 1]);
        expectRefusalOnly(admitted, f.snapshot(), overflow.envelope);
        expect(rows()).toHaveLength(64);
      } else if (mode === "retention") {
        for (let i = 1; i <= 66; i++) {
          f.clock.mockReturnValue(now + i * 600_000);
          const ask = await f.send(
            call("lane.resume", { all: true }, `ask-${i}`),
          );
          expect(ask.verdict).toEqual(["FAIL", "APPROVAL_REQUIRED", 1]);
          expect(ask.status).toBe(409);
        }
        expect(
          rows().filter((entry) => entry.status === "expired"),
        ).toHaveLength(64);
        expect(
          rows().filter((entry) => entry.status === "pending"),
        ).toHaveLength(1);
        // Trimming current state must also bound request data retained in event snapshots.
        const history = f.db
          .query(
            "SELECT body FROM state_events WHERE namespace='forge/work' AND key='lane-approval:requests'",
          )
          .all() as { body: string }[];
        const persisted = history.flatMap(
          ({ body }) =>
            (JSON.parse(body) as { data?: { requests?: LaneApproval[] } }).data
              ?.requests ?? [],
        );
        expect(
          new Set([...rows(), ...persisted].map((entry) => entry.request)).size,
        ).toBeLessThanOrEqual(65);
      } else {
        if (mode === "epoch")
          await f.send(call("lane.stop", { all: true }, "new-stop"));
        const current = (await control(f)).result as {
          incarnation: string;
          epoch: number;
          stopped: boolean;
        };
        const before = f.snapshot();
        const observed =
          mode === "incarnation"
            ? { ...current, incarnation: "replacement" }
            : current;
        expect(
          laneApprovalStatus(
            row,
            observed,
            mode === "expired" ? now + 600_000 : now,
          ),
        ).toBe(mode === "expired" ? "expired" : "stale");
        expect(f.snapshot()).toBe(before);
      }
    } finally {
      f.close();
    }
  },
  10_000,
);

const pageCookie = (page: { headers: Headers }) =>
  (page.headers.get("set-cookie") ?? "").split(";")[0]!;
const pageTicket = (page: { text: string }, action: string) =>
  new RegExp(
    `/${action}"><input type="hidden" name="ticket" value="([^"]+)"`,
  ).exec(page.text)?.[1] ?? "";
async function browserFixture(
  scope: "all" | "issue" | "chat" = "all",
  issuer = "https://identity.example",
  verify?: NonNullable<DeviceBrowserOptions["upstream"]>["verify"],
  ingress?: ReturnType<typeof stockIngress>,
) {
  const begun: { state: string; verifier: string }[] = [];
  const spent = new Set<string>();
  let duringBegin = () => {};
  let duringClaim = () => {};
  const f = await fixture(
    "p",
    "s1",
    {
      upstream: {
        begin: (state, verifier) => {
          begun.push({ state, verifier });
          return Promise.resolve().then(() => {
            duringBegin();
            return `${new URL("/oauth/authorize", issuer).href}?state=${state}&redirect_uri=https%3A%2F%2Fw.example%2Fcallback`;
          });
        },
        verify:
          verify ??
          (() => {
            throw new Error("This slice must not verify an owner");
          }),
      },
      redemption: {
        claimOnce: (hash) => {
          const won = !spent.has(hash);
          spent.add(hash);
          return Promise.resolve().then(() => {
            duringClaim();
            return won;
          });
        },
      },
    },
    ingress,
  );
  f.env.CLERK_ISSUER = issuer;
  f.put("lane-control:global", running);
  const input = scope === "issue" ? { id: "work-7" } : { all: true };
  await f.send(call("lane.stop", input, "browser-stop"));
  const reply = await f.send(call("lane.resume", input, "browser-ask"));
  expect(reply.verdict).toEqual(["FAIL", "APPROVAL_REQUIRED", 1]);
  expect(reply.status).toBe(409);
  const pending = (
    reply.envelope as unknown as {
      result: { request: string; expiresAt: string };
    }
  ).result;
  if (scope !== "chat") seedLegacyApproval(f, pending.request);
  const path = `/lane-approval/${pending.request}`;
  const shown = await f.browser(path);
  const cookie = pageCookie(shown);
  const submit = (
    action = "approve",
    ticket = pageTicket(shown, action),
    extra: Record<string, string> = {},
  ) =>
    f.browser(`${path}/${action}`, new URLSearchParams({ ticket }).toString(), {
      Origin: "https://w.example",
      Cookie: cookie,
      ...extra,
    });
  return {
    ...f,
    path,
    shown,
    pending,
    cookie,
    submit,
    begun,
    spent,
    duringBegin: (run: () => void) => {
      duringBegin = run;
    },
    duringClaim: (run: () => void) => {
      duringClaim = run;
    },
  };
}

test.each(["approve", "deny"] as const)(
  "stock Workers suspend lane browser preview, %s and callback",
  async (action) => {
    const ingress = stockIngress();
    const f = await browserFixture(
      "all",
      undefined,
      () => ownerProof(),
      ingress,
    );
    try {
      expect(f.shown.status).toBe(200);
      const decision = await f.submit(action);
      expect(decision.status).toBe(302);
      const state = f.begun[0]!.state;
      const callback = await f.browser(
        `/callback?state=${state}&code=owner`,
        undefined,
        { Cookie: pageCookie(decision) },
        true,
      );
      expect(callback.status).toBe(200);
      ingress.expect([
        `GET ${f.path}`,
        `POST ${f.path}/${action}`,
        "GET /callback",
      ]);
    } finally {
      f.close();
    }
  },
  10_000,
);

test.each(["all", "issue"] as const)(
  "lane browser preview is read-only for %s",
  async (scope) => {
    const f = await browserFixture(scope);
    try {
      const before = f.snapshot(),
        writes = f.writes();
      const page = await f.browser(f.path, undefined, {
        Host: "evil.example",
        Origin: "https://evil.example",
        "X-Forwarded-Host": "evil.example",
      });
      expect(page.status).toBe(200);
      for (const text of [
        "p",
        scope === "all" ? "ALL LANES" : "work-7",
        "Affected scope",
        "Current stop",
        f.pending.expiresAt,
        "https://w.example/lane-approval/",
      ])
        expect(page.text).toContain(text);
      expect(page.text).not.toContain("evil.example");
      expect(page.headers.get("cache-control")).toBe("no-store");
      expect(page.headers.get("content-security-policy")).toContain(
        "frame-ancestors 'none'",
      );
      expect([f.snapshot(), f.writes(), f.begun.length, f.spent.size]).toEqual([
        before,
        writes,
        0,
        0,
      ]);
    } finally {
      f.close();
    }
  },
  10_000,
);

test.each([
  "unknown",
  "expired",
  "epoch",
  "incarnation",
  "spent",
  "policy",
  "revoked",
])(
  "lane preview refuses %s without writes or actions",
  async (mode) => {
    const f = await browserFixture();
    try {
      if (mode === "expired") f.clock.mockReturnValue(now + 600_000);
      if (mode === "epoch" || mode === "incarnation") {
        const old = f.owner.get("forge/work", "lane-control:global")!;
        f.owner.put(
          "forge/work",
          old.key,
          {
            ...(old.value as object),
            ...(mode === "epoch" ? { epoch: 99 } : { incarnation: "new" }),
          },
          actor,
          { expectRevision: old.revision },
        );
      }
      if (mode === "spent")
        f.db.run(
          `UPDATE ${LANE_APPROVALS} SET state=json_set(state, '$.requests[0].status', 'spent')`,
        );
      if (mode === "policy") f.env.FORGE_OWNER_SUBJECT = "user_Other2";
      if (mode === "revoked")
        f.db.run("UPDATE domain_cloud_tokens SET revoked_at=?", [now]);
      const before = f.snapshot(),
        writes = f.writes();
      const page = await f.browser(
        mode === "unknown" ? "/lane-approval/unknown" : f.path,
      );
      expect(page.status).toBe(400);
      expect(page.text).not.toContain("<form");
      expect(page.headers.get("set-cookie")).toBeNull();
      expect([f.snapshot(), f.writes()]).toEqual([before, writes]);
    } finally {
      f.close();
    }
  },
  10_000,
);

test.each(["approve", "deny"])(
  "lane %s starts Clerk once and leaves approval pending",
  async (action) => {
    const f = await browserFixture();
    try {
      const before = f.snapshot();
      const replies = await Promise.all([f.submit(action), f.submit(action)]);
      expect(replies.map((r) => r.status).sort()).toEqual([302, 400]);
      const reply = replies.find((r) => r.status === 302)!;
      expect(f.begun).toHaveLength(1);
      expect(f.begun[0]!.state).toMatch(/^forge-lane\./);
      expect(f.begun[0]!.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
      for (const part of [
        "__Host-forge_lane_",
        "Secure",
        "HttpOnly",
        "SameSite=Lax",
        "Path=/",
      ])
        expect(reply.headers.get("set-cookie")).toContain(part);
      expect(reply.headers.get("set-cookie")).not.toContain("Domain=");
      expect(
        new URL(reply.headers.get("location")!).searchParams.get(
          "redirect_uri",
        ),
      ).toBe("https://w.example/callback");
      expect(f.snapshot()).toBe(before);
      expect((await f.submit(action)).status).toBe(400);
    } finally {
      f.close();
    }
  },
  10_000,
);

test.each([
  "foreign origin",
  "missing origin",
  "missing ticket",
  "device ticket",
  "other action",
  "other browser",
  "device cookie",
  "duplicate",
  "unknown field",
  "expired",
  "changed during upstream",
])(
  "lane start refuses %s",
  async (mode) => {
    const f = await browserFixture();
    try {
      let fields = new URLSearchParams({
        ticket: pageTicket(
          f.shown,
          mode === "other action" ? "deny" : "approve",
        ),
      }).toString();
      const headers: Record<string, string> = {
        Origin: "https://w.example",
        Cookie: f.cookie,
      };
      if (mode === "foreign origin") headers.Origin = "https://evil.example";
      if (mode === "missing origin") delete headers.Origin;
      if (mode === "missing ticket") fields = "";
      if (mode === "device ticket") fields = `ticket=${"a".repeat(43)}`;
      if (mode === "other browser")
        headers.Cookie = `__Host-forge_lane_preview=${"x".repeat(43)}`;
      if (mode === "device cookie")
        headers.Cookie = `__Host-forge_device=${"x".repeat(43)}`;
      if (mode === "duplicate") fields += `&${fields}`;
      if (mode === "unknown field") fields += "&owner=yes";
      if (mode === "expired") f.clock.mockReturnValue(now + 600_000);
      if (mode === "changed during upstream")
        f.duringBegin(() => {
          f.env.FORGE_OWNER_SUBJECT = "user_Other2";
        });
      const before = f.snapshot();
      const reply = await f.browser(`${f.path}/approve`, fields, headers);
      expect(reply.status).toBe(400);
      expect(reply.headers.get("location")).toBeNull();
      expect(f.snapshot()).toBe(before);
      if (mode !== "changed during upstream")
        expect([f.begun.length, f.spent.size]).toEqual([0, 0]);
      if (
        [
          "foreign origin",
          "missing origin",
          "duplicate",
          "unknown field",
        ].includes(mode)
      )
        expect((await f.submit()).status).toBe(302);
    } finally {
      f.close();
    }
  },
  10_000,
);

test.each(["lane", "mixed lane and device", "device", "generic"])(
  "production callback routes %s in its own domain",
  async (mode) => {
    const f = await browserFixture();
    try {
      const states =
        mode === "lane"
          ? ["forge-lane.state"]
          : mode === "mixed lane and device"
            ? ["forge-device.state", "forge-lane.state"]
            : [mode === "device" ? "forge-device.state" : "generic-state"];
      const query = new URLSearchParams(
        states.map((state): [string, string] => ["state", state]),
      );
      const reached = f.reached.length,
        before = f.snapshot();
      const reply = await f.browser(
        `/callback?${query}`,
        undefined,
        {
          Cookie:
            "__Host-forge_device=foreign; __Host-forge_lane_wrong=foreign",
          "CF-Connecting-IP": "203.0.113.1",
        },
        true,
      );
      expect(reply.status).toBe(mode === "generic" ? 503 : 400);
      expect(f.reached.length - reached).toBe(mode === "generic" ? 0 : 1);
      if (mode.includes("lane"))
        expect(reply.text).toContain("This request cannot be used.");
      if (mode !== "device") expect(f.snapshot()).toBe(before);
      expect(f.begun).toEqual([]);
    } finally {
      f.close();
    }
  },
  10_000,
);

const approvalRows = (f: Fixture) =>
  (
    JSON.parse(
      String(
        (
          f.db
            .query(`SELECT state FROM ${LANE_APPROVALS} WHERE id=1`)
            .get() as { state: string }
        ).state,
      ),
    ) as { requests: LaneApproval[] }
  ).requests;
function seedLegacyApproval(f: Fixture, request: string) {
  const requests = approvalRows(f).map((row) => {
    if (row.request !== request) return row;
    const { binding: _binding, ...legacy } = row;
    return { ...legacy, url: `https://w.example/lane-approval/${request}` };
  });
  f.db.run(`UPDATE ${LANE_APPROVALS} SET state=? WHERE id=1`, [
    JSON.stringify({ requests }),
  ]);
}

const ownerClaims: IdentityClaims = {
  issuer: "https://identity.example",
  subject: "user_Owner1",
  audience: "forge-cloud",
  authenticatedAt: now - 1_000,
  expiresAt: now + 3_600_000,
};
const ownerProof = (changes: Partial<IdentityClaims> = {}) => {
  const claims = { ...ownerClaims, ...changes };
  return testIdentityVerifier(new Map([["owner", claims]])).verify(
    "owner",
    claims.audience,
    now,
  );
};

async function resumeFixture(
  scope: "all" | "issue" = "all",
  id = "work-7",
  prefix?: string,
) {
  const f = await fixture();
  if (prefix !== undefined)
    for (const key of ["issue:work-7", "issue:work-8"]) {
      const issue = f.owner.get("forge/work", key)!;
      f.owner.put(
        "forge/work",
        key,
        { ...(issue.value as object), prefix },
        actor,
        { expectRevision: issue.revision },
      );
    }
  const target: RelayScope = scope === "all" ? { all: true } : { id };
  await stopForRelay(f, target);
  for (const id of scope === "all" ? ["work-7", "work-8"] : ["work-8"])
    f.put(`lane-control:${id}`, {
      version: 1,
      incarnation: "history",
      id,
      epoch: 4,
      stoppedAt: new Date(now).toISOString(),
    });
  const { input, complete } = await askForRelay(f, target);
  return { ...f, input, resume: complete };
}
const replaceApproval = (f: Fixture, changes: Partial<LaneApproval>) =>
  f.db.run(`UPDATE ${LANE_APPROVALS} SET state=? WHERE id=1`, [
    JSON.stringify({
      requests: approvalRows(f).map((row) => ({ ...row, ...changes })),
    }),
  ]);

test.each([
  ["forge-7", undefined],
  ["work-7", undefined],
  ["WORK-7", undefined],
  ["FORGE-7", undefined],
  ["work-7", "forge"],
] as const)(
  "stop, control and approved resume resolve %s with stored issue prefix %s",
  async (id, prefix) => {
    const f = await resumeFixture("issue", id, prefix);
    try {
      expect(f.env.FORGE_CLOUD_ID_PREFIX).toBe("forge");
      expect((await control(f, id)).result).toMatchObject({ stopped: true });
      expect(approvalRows(f)[0]).toMatchObject({
        scope: { id: "work-7" },
        status: "pending",
      });
      const issue = f.owner.get("forge/work", "issue:work-7");
      if (prefix !== undefined) expect(issue!.value).toMatchObject({ prefix });
      const unrelated = f.owner.get("forge/work", "lane-control:work-8");
      const reply = await f.send(f.resume);
      expect(reply.verdict).toEqual(["OK", "OK", 0]);
      expect(reply.result).toEqual({ resumed: "work-7" });
      expect((await control(f, id)).result).toMatchObject({ stopped: false });
      expect(
        f.owner.get("forge/work", "lane-control:work-7")!.value,
      ).toMatchObject({ id: "work-7", stoppedAt: null });
      expect(f.owner.get("forge/work", "issue:work-7")).toEqual(issue);
      expect(f.owner.get("forge/work", "lane-control:work-8")).toEqual(
        unrelated,
      );
      for (const alias of ["forge-7", "WORK-7", "FORGE-7"])
        expect(
          f.owner.get("forge/work", `lane-control:${alias}`),
        ).toBeUndefined();
    } finally {
      f.close();
    }
  },
  10_000,
);

type RelayScope = { all: true } | { id: string };
const chatReply = {
  quote: " \tYes, resume these lanes.\n",
  source: {
    harness: "test-chat",
    thread: "owner-thread",
    message: "owner-message",
    link: "https://chat.example.test/owner-message",
  },
};
const challenge = (reply: Awaited<ReturnType<Fixture["send"]>>) =>
  (
    reply.envelope as unknown as {
      result: { request: string; scope: RelayScope; expiresAt: string };
    }
  ).result;

async function stopForRelay(f: Fixture, scope: RelayScope) {
  f.put("lane-control:global", running);
  expect((await f.send(call("lane.stop", scope, "relay-stop"))).status).toBe(
    200,
  );
}

async function askForRelay(f: Fixture, scope: RelayScope) {
  const issue = call("lane.resume", scope, "relay-ask");
  const reply = await f.send(issue);
  expect(reply.verdict).toEqual(["FAIL", "APPROVAL_REQUIRED", 1]);
  const approval = { request: challenge(reply).request, ...chatReply };
  const input = { ...scope, approval };
  return { issue, reply, input, complete: call("lane.resume", input, "relay") };
}

test("chat relay red 1: wire challenge has only the request, scope and deadline", async () => {
  const f = await fixture();
  try {
    const scope = { all: true } as const;
    await stopForRelay(f, scope);
    const before = await control(f);
    const { reply } = await askForRelay(f, scope);
    expect(reply.status).toBe(409);
    expect(challenge(reply).request).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
    expect((await control(f)).result).toEqual(before.result);
    expect(before.result).toMatchObject({ stopped: true, scope: "all" });
    expect(challenge(reply)).toEqual({
      request: challenge(reply).request,
      scope,
      expiresAt: new Date(now + 600_000).toISOString(),
    });
  } finally {
    f.close();
  }
}, 10_000);

const completionReceipts = (f: Fixture) =>
  f.db
    .query<{ result: string }, []>(
      "SELECT result FROM domain_cloud_command_receipts WHERE outcome='ok' ORDER BY request_id",
    )
    .all();

test.each([{ all: true }, { id: "work-7" }] as const)(
  "chat relay red 2: completion spends one request and records the exact reply for %j",
  async (scope) => {
    const f = await fixture();
    try {
      await stopForRelay(f, scope);
      const { input, complete } = await askForRelay(f, scope);
      const [pending] = approvalRows(f);
      expect(pending?.status).toBe("pending");
      const receiptsBefore = completionReceipts(f);
      const result = { resumed: "id" in scope ? scope.id : "all" };
      const reply = await f.send(complete);
      expect(reply.status).toBe(200);
      expect(reply.result).toEqual(result);
      expect(approvalRows(f)).toHaveLength(1);
      expect(approvalRows(f)[0]).toMatchObject({
        request: input.approval.request,
        scope,
        status: "spent",
        token: pending!.token,
        device: pending!.device,
        session: pending!.session,
        decision: {
          method: "relayed",
          ...chatReply,
          at: new Date(now).toISOString(),
        },
      });
      const receiptsAfter = completionReceipts(f);
      expect(receiptsAfter).toHaveLength(receiptsBefore.length + 1);
      expect(
        receiptsAfter
          .filter(
            (row) => !receiptsBefore.some((old) => old.result === row.result),
          )
          .map((row) => JSON.parse(row.result) as unknown),
      ).toEqual([result]);
      expect(
        (await control(f, "id" in scope ? scope.id : undefined)).result,
      ).toMatchObject({ stopped: false, epoch: running.epoch + 2 });
      const spent = approvalRows(f);
      const duplicate = await f.send({ ...complete, requestId: "relay-again" });
      expect(duplicate.verdict).toEqual(["FAIL", "APPROVAL_REQUIRED", 1]);
      expect(approvalRows(f)).toEqual(spent);
    } finally {
      f.close();
    }
  },
  10_000,
);

test.each([
  "different scope",
  "different request",
  "renewed token",
  "expired",
  "later stop",
  "blank quote",
  "blank source",
  "credential in quote",
  "browser-approved row",
  "receipt write failure",
] as const)(
  "chat relay keeps the stop and request intact after %s",
  async (mode) => {
    const f = await fixture();
    try {
      const scope = { id: "work-7" };
      await stopForRelay(f, scope);
      expect(
        (await f.send(call("lane.stop", { id: "work-8" }, "other-stop")))
          .status,
      ).toBe(200);
      const { input, complete } = await askForRelay(f, scope);
      let attempt = complete;
      let headers: Record<string, string> = {};
      switch (mode) {
        case "different scope":
          attempt = {
            ...complete,
            input: { all: true, approval: input.approval },
          };
          break;
        case "different request":
          attempt = {
            ...complete,
            input: {
              ...input,
              approval: { ...input.approval, request: crypto.randomUUID() },
            },
          };
          break;
        case "renewed token":
          headers = { authorization: `Bearer ${await f.admit("laptop")}` };
          break;
        case "expired":
          f.clock.mockReturnValue(now + 600_000);
          break;
        case "later stop":
          expect(
            (await f.send(call("lane.stop", scope, "new-stop"))).status,
          ).toBe(200);
          break;
        case "blank quote":
          attempt = {
            ...complete,
            input: { ...input, approval: { ...input.approval, quote: " \n" } },
          };
          break;
        case "blank source":
          attempt = {
            ...complete,
            input: {
              ...input,
              approval: {
                ...input.approval,
                source: { ...chatReply.source, thread: " \t" },
              },
            },
          };
          break;
        case "credential in quote":
          attempt = {
            ...complete,
            input: {
              ...input,
              approval: { ...input.approval, quote: "yes fct_example" },
            },
          };
          break;
        case "browser-approved row":
          replaceApproval(f, {
            status: "approved",
            decision: {
              issuer: ownerClaims.issuer,
              subject: ownerClaims.subject,
              at: new Date(now).toISOString(),
            },
          });
          break;
        case "receipt write failure":
          f.db.run(
            "CREATE TRIGGER refuse_relay BEFORE INSERT ON domain_cloud_command_receipts BEGIN SELECT RAISE(ABORT, 'injected relay failure'); END",
          );
          break;
      }
      const before = f.snapshot();
      const reply = await f.send(attempt, "p", headers);
      expect(reply.envelope.ok).toBe(false);
      expect(f.snapshot()).toBe(before);
      expect((await control(f, scope.id)).result).toMatchObject({
        stopped: true,
      });
      if (mode === "receipt write failure") {
        f.db.run("DROP TRIGGER refuse_relay");
        expect((await f.send(attempt)).status).toBe(200);
      }
    } finally {
      f.close();
    }
  },
  10_000,
);

test.each(["later stop", "spent", "expired"] as const)(
  "chat relay red 4: issuance replay refuses a %s request without an ask",
  async (mode) => {
    const f = await fixture();
    try {
      const scope = { all: true } as const;
      await stopForRelay(f, scope);
      const { issue, reply } = await askForRelay(f, scope);
      const first = f.snapshot();
      expect((await f.send(issue)).envelope).toEqual(reply.envelope);
      expect(f.snapshot()).toBe(first);
      if (mode === "later stop")
        expect(
          (await f.send(call("lane.stop", scope, "new-stop"))).status,
        ).toBe(200);
      if (mode === "spent") replaceApproval(f, { status: "spent" });
      if (mode === "expired") f.clock.mockReturnValue(now + 600_000);
      const before = f.snapshot();
      const replay = await f.send(issue);
      expect(replay.verdict).toEqual(["FAIL", "APPROVAL_REQUIRED", 1]);
      expect(replay.envelope).not.toHaveProperty("result");
      if (replay.envelope.ok) throw new Error("Expected approval refusal");
      expect(replay.envelope.error.message).toMatch(
        /(?:new|fresh) (?:approval )?request/i,
      );
      expect(f.snapshot()).toBe(before);
    } finally {
      f.close();
    }
  },
  10_000,
);

test("chat relay red 5: completion replay keeps a later stop and epoch", async () => {
  const f = await fixture();
  try {
    const scope = { all: true } as const;
    await stopForRelay(f, scope);
    const { complete } = await askForRelay(f, scope);
    const result = await f.send(complete);
    expect(result.status).toBe(200);
    const later = await f.send(call("lane.stop", scope, "new-stop"));
    expect(later.status).toBe(200);
    expect(later.result).toMatchObject({
      stopped: true,
      epoch: running.epoch + 3,
    });
    const before = f.snapshot();
    expect((await f.send(complete)).envelope).toEqual(result.envelope);
    expect((await control(f)).result).toEqual(later.result);
    expect(f.snapshot()).toBe(before);
  } finally {
    f.close();
  }
}, 10_000);

test("chat relay completes without a Clerk redirect URI", async () => {
  const f = await fixture();
  try {
    f.env.CLERK_REDIRECT_URI = "";
    const scope = { all: true } as const;
    await stopForRelay(f, scope);
    const { complete } = await askForRelay(f, scope);
    expect((await f.send(complete)).status).toBe(200);
    expect((await control(f)).result).toMatchObject({ stopped: false });
  } finally {
    f.close();
  }
}, 10_000);

test("chat relay refuses a newly issued request at the old browser URLs", async () => {
  const f = await browserFixture("chat");
  try {
    const before = f.snapshot();
    const approve = await f.submit();
    expect(f.shown.status).toBe(400);
    expect(approve.status).toBe(400);
    expect(f.begun).toHaveLength(0);
    expect(f.spent.size).toBe(0);
    expect(f.snapshot()).toBe(before);
  } finally {
    f.close();
  }
}, 10_000);

test("a chat request cannot spend valid legacy browser callback state", async () => {
  const verify = mock(async () => ownerProof());
  const f = await browserFixture("chat", undefined, verify);
  try {
    const state = LANE_STATE_PREFIX + "s".repeat(43);
    const bind = "b".repeat(43);
    const stateHash = await sha256(state);
    f.db.run(`INSERT INTO ${LANE_BROWSER} (id, state) VALUES (1, ?)`, [
      JSON.stringify([
        {
          request: f.pending.request,
          action: "approve",
          stateHash,
          bindHash: await sha256(bind),
          verifier: "v".repeat(43),
          expiresAt: Date.parse(f.pending.expiresAt),
        },
      ]),
    ]);
    const callback = () =>
      f.browser(
        `/callback?state=${state}&code=owner`,
        undefined,
        {
          Cookie: `__Host-forge_lane_${stateHash.slice(0, 24)}=${bind}`,
        },
        true,
      );
    const snapshot = () => [
      f.snapshot(),
      f.db.query(`SELECT * FROM ${LANE_BROWSER}`).all(),
    ];

    const before = snapshot();
    expect((await callback()).status).toBe(400);
    expect(snapshot()).toEqual(before);
    expect(f.spent.size).toBe(0);
    expect(verify).not.toHaveBeenCalled();

    seedLegacyApproval(f, f.pending.request);
    expect((await callback()).status).toBe(200);
    expect(verify).toHaveBeenCalledTimes(1);
  } finally {
    f.close();
  }
}, 10_000);

test("the private lane reply stays out of dumps, receipts and console logs", async () => {
  const f = await fixture();
  const logged: string[] = [];
  const spies = (["log", "warn", "error", "info", "debug"] as const).map(
    (method) =>
      spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(format(...args));
      }),
  );
  try {
    Object.assign(f.env, { DUMP_PAGE_BYTES: "4096" });
    f.reopen();
    const scope = { all: true } as const;
    await stopForRelay(f, scope);
    const { input } = await askForRelay(f, scope);
    const quote = "Yes, resume. Private restore-lane reply 5da7c2.";
    const source = {
      harness: "private-harness-5da7c2",
      thread: "private-thread-5da7c2",
      message: "private-message-5da7c2",
      link: "https://example.test/private-reply-5da7c2",
    };
    const relay = { ...input.approval, quote, source };
    const result = await f.send(
      call("lane.resume", { ...scope, approval: relay }, "private-relay"),
    );
    expect(result.status).toBe(200);
    expect(approvalRows(f)[0]).toMatchObject({
      status: "spent",
      decision: { quote, source },
    });

    const receipts = f.db
      .query<{ request_id: string }, []>(
        "SELECT * FROM domain_cloud_command_receipts WHERE json_extract(result, '$.resumed')='all'",
      )
      .all();
    expect(receipts).toHaveLength(1);
    const whole = await f.dump();
    expect(whole.status).toBe(200);
    const wholeText = await whole.text();
    const pages: string[] = [];
    let cursor: string | null = "start";
    while (cursor !== null) {
      const response = await f.dump(cursor);
      expect(response.status).toBe(200);
      const text = await response.text();
      pages.push(text);
      const value = (JSON.parse(text) as { value: { next: string | null } })
        .value;
      cursor = value.next;
    }
    const pagedText = pages.join("\n");
    const completionId = receipts[0]!.request_id;
    expect(wholeText).toContain(completionId);
    expect(pagedText).toContain(completionId);
    for (const surface of [
      wholeText,
      pagedText,
      JSON.stringify(receipts),
      logged.join("\n"),
    ])
      for (const privateText of [quote, ...Object.values(source)])
        expect(surface).not.toContain(privateText);
  } finally {
    for (const spy of spies) spy.mockRestore();
    f.close();
  }
}, 10_000);

test("chat relay refuses request-only completion with a legacy browser decision", async () => {
  const f = await fixture();
  try {
    const scope = { all: true } as const;
    await stopForRelay(f, scope);
    const { input } = await askForRelay(f, scope);
    const { request } = input.approval;
    const {
      project,
      incarnation,
      epoch,
      policyIdentity,
      token,
      device,
      session,
      expiresAt,
    } = approvalRows(f)[0]!;
    f.db.run(`UPDATE ${LANE_APPROVALS} SET state=? WHERE id=1`, [
      JSON.stringify({
        requests: [
          {
            request,
            scope,
            expiresAt,
            project,
            incarnation,
            epoch,
            policyIdentity,
            token,
            device,
            session,
            url: `https://w.example/lane-approval/${request}`,
            status: "approved",
            decision: {
              issuer: ownerClaims.issuer,
              subject: ownerClaims.subject,
              at: new Date(now).toISOString(),
            },
          },
        ],
      }),
    ]);
    const before = f.snapshot();
    const reply = await f.send(
      call("lane.resume", { ...scope, approval: { request } }, "legacy-resume"),
    );
    expect(reply.envelope.ok).toBe(false);
    expect(f.snapshot()).toBe(before);
    expect((await control(f)).result).toMatchObject({ stopped: true });
  } finally {
    f.close();
  }
}, 10_000);

test.each(["all", "issue"] as const)(
  "approved resume %s commits once and replays historically after a later stop",
  async (scope) => {
    const f = await resumeFixture(scope);
    try {
      const before = (await control(f)).result as { epoch: number };
      const unrelated = f.owner.get("forge/work", "issue:work-8");
      const reply = await f.send(f.resume);
      expect(reply.verdict).toEqual(["OK", "OK", 0]);
      expect(reply.status).toBe(200);
      expect(reply.result).toEqual({
        resumed: scope === "all" ? "all" : "work-7",
      });
      expect(approvalRows(f)[0]!.status).toBe("spent");
      expect((await control(f, "work-7")).result).toMatchObject({
        epoch: before.epoch + 1,
        stopped: false,
      });
      expect((await control(f, "work-8")).result).toMatchObject({
        stopped: scope === "issue",
      });
      expect(f.owner.get("forge/work", "issue:work-8")).toEqual(unrelated);
      const global = f.owner.get("forge/work", "lane-control:global")!.value;
      expect(global).toMatchObject({
        stopAll: null,
        resumeAllEpoch: scope === "all" ? before.epoch + 1 : 0,
      });
      await f.send(call("lane.stop", { id: "work-7" }, "later-stop"));
      const stoppedAgain = f.snapshot();
      expect((await f.send(f.resume)).envelope).toEqual(reply.envelope);
      expect(f.snapshot()).toBe(stoppedAgain);
      expect((await control(f, "work-7")).result).toMatchObject({
        stopped: true,
      });
    } finally {
      f.close();
    }
  },
  10_000,
);

test.each([
  ["legacy pending", "APPROVAL_REQUIRED"],
  ["denied", "APPROVAL_REQUIRED"],
  ["spent", "APPROVAL_REQUIRED"],
  ["expired", "APPROVAL_REQUIRED"],
  ["missing", "APPROVAL_REQUIRED"],
  ["epoch", "INPUT_CONFLICT"],
  ["incarnation", "INPUT_CONFLICT"],
  ["policy", "INPUT_CONFLICT"],
  ["project", "INPUT_CONFLICT"],
  ["other issue", "INPUT_CONFLICT"],
  ["all scope", "INPUT_CONFLICT"],
  ["global stop", "INPUT_CONFLICT"],
  ["all later stop", "INPUT_CONFLICT"],
  ["quote", "INPUT_INVALID"],
  ["source", "INPUT_INVALID"],
] as const)(
  "resume refuses %s approval without changing storage",
  async (mode, code) => {
    const f = await resumeFixture(mode === "all later stop" ? "all" : "issue");
    try {
      let input: object = f.input;
      if (mode === "legacy pending")
        seedLegacyApproval(f, f.input.approval.request);
      if (["denied", "spent"].includes(mode))
        replaceApproval(f, { status: mode as LaneApproval["status"] });
      if (mode === "expired") f.clock.mockReturnValue(now + 600_000);
      if (mode === "missing")
        input = {
          ...f.input,
          approval: { ...f.input.approval, request: "missing" },
        };
      if (["epoch", "global stop", "all later stop"].includes(mode))
        await f.send(
          call(
            "lane.stop",
            mode === "global stop" ? { all: true } : { id: "work-8" },
            "changed-stop",
          ),
        );
      if (mode === "incarnation")
        replaceApproval(f, { incarnation: "old-history" });
      if (mode === "policy") f.env.FORGE_OWNER_SUBJECT = "user_Changed2";
      if (mode === "project") replaceApproval(f, { project: "other" });
      if (mode === "other issue") input = { ...f.input, id: "work-8" };
      if (mode === "all scope")
        input = { all: true, approval: f.input.approval };
      if (mode === "quote" || mode === "source")
        input = {
          ...f.input,
          approval: {
            request: f.input.approval.request,
            [mode]:
              mode === "quote" ? "yes" : { harness: "test", thread: "owner" },
          },
        };
      const before = f.snapshot();
      const reply = await f.send(call("lane.resume", input, "refused-resume"));
      expect(reply.verdict).toEqual([
        "FAIL",
        code,
        code === "INPUT_INVALID" ? 6 : code === "INPUT_CONFLICT" ? 4 : 1,
      ]);
      expect(reply.status).toBe(code === "INPUT_INVALID" ? 400 : 409);
      expect(f.snapshot()).toBe(before);
    } finally {
      f.close();
    }
  },
  10_000,
);

test.each(["device", "renewed token", "body", "new request"])(
  "a successful resume cannot be reused with a changed %s",
  async (mode) => {
    const f = await resumeFixture();
    try {
      const alternate = await f.admit(mode === "device" ? "desktop" : "laptop");
      expect((await f.send(f.resume)).verdict).toEqual(["OK", "OK", 0]);
      await f.send(call("lane.stop", { all: true }, "stopped-again"));
      const before = f.snapshot();
      const reply = await f.send(
        mode === "body"
          ? { ...f.resume, input: { id: "work-7", approval: f.input.approval } }
          : mode === "new request"
            ? { ...f.resume, requestId: "another-consume" }
            : f.resume,
        "p",
        mode === "device" || mode === "renewed token"
          ? { authorization: `Bearer ${alternate}` }
          : {},
      );
      expect(reply.verdict).toEqual([
        "FAIL",
        mode === "body" ? "INPUT_CONFLICT" : "APPROVAL_REQUIRED",
        mode === "body" ? 4 : 1,
      ]);
      expect(f.snapshot()).toBe(before);
      expect((await control(f)).result).toMatchObject({ stopped: true });
    } finally {
      f.close();
    }
  },
  10_000,
);

test("an approval from another project changes neither project", async () => {
  const f = await resumeFixture();
  const other = await fixture("other");
  try {
    await other.send(call("lane.stop", { all: true }, "other-stop"));
    other.db.run(`INSERT INTO ${LANE_APPROVALS} (id, state) VALUES (1, ?)`, [
      JSON.stringify({ requests: approvalRows(f) }),
    ]);
    const before = [f.snapshot(), other.snapshot()];
    expect((await other.send(f.resume)).verdict).toEqual([
      "FAIL",
      "INPUT_CONFLICT",
      4,
    ]);
    expect([f.snapshot(), other.snapshot()]).toEqual(before);
  } finally {
    other.close();
    f.close();
  }
}, 10_000);

test("two admitted devices racing for one approval have one winner", async () => {
  const f = await resumeFixture();
  try {
    const alternate = await f.admit("desktop");
    const before = (await control(f)).result as { epoch: number };
    const replies = await Promise.all([
      f.send(f.resume),
      f.send(f.resume, "p", { authorization: `Bearer ${alternate}` }),
    ]);
    expect(replies.map((reply) => reply.verdict).sort()).toEqual([
      ["FAIL", "APPROVAL_REQUIRED", 1],
      ["OK", "OK", 0],
    ]);
    expect(approvalRows(f)[0]!.status).toBe("spent");
    expect((await control(f)).result).toMatchObject({
      epoch: before.epoch + 1,
      stopped: false,
    });
  } finally {
    f.close();
  }
}, 10_000);

test.each(["approval", "control", "receipt"])(
  "resume rolls back approval, control and receipt on a failed %s write",
  async (where) => {
    const f = await resumeFixture();
    try {
      const target =
        where === "approval"
          ? LANE_APPROVALS
          : where === "control"
            ? "state_records WHEN NEW.key = 'lane-control:global'"
            : "domain_cloud_command_receipts";
      const operation = where === "receipt" ? "INSERT" : "UPDATE";
      f.db.run(
        `CREATE TRIGGER refuse_resume BEFORE ${operation} ON ${target} BEGIN SELECT RAISE(ABORT, 'injected resume failure'); END`,
      );
      const before = f.snapshot();
      expect((await f.send(f.resume)).envelope.ok).toBe(false);
      expect(f.snapshot()).toBe(before);
      f.db.run("DROP TRIGGER refuse_resume");
      expect((await f.send(f.resume)).verdict).toEqual(["OK", "OK", 0]);
      expect(approvalRows(f)[0]!.status).toBe("spent");
    } finally {
      f.close();
    }
  },
  10_000,
);

test.each([false, true])(
  "an executor revoked before resume or replay is refused, replay %s",
  async (replayed) => {
    const f = await resumeFixture();
    try {
      if (replayed)
        expect((await f.send(f.resume)).verdict).toEqual(["OK", "OK", 0]);
      f.db.run("UPDATE domain_cloud_tokens SET revoked_at=?", [now]);
      const before = f.snapshot();
      expect((await f.send(f.resume)).envelope.ok).toBe(false);
      expect(f.snapshot()).toBe(before);
    } finally {
      f.close();
    }
  },
  10_000,
);

test.each(["cloud", "local", "partial local"])(
  "resume schema accepts the distinct %s approval variant",
  (mode) => {
    const approval = {
      request: "request-1",
      ...(mode === "cloud" ? {} : { quote: "yes" }),
      ...(mode === "local"
        ? { source: { harness: "test", thread: "owner" } }
        : {}),
    };
    expect(
      validateWithSchema(ResumeInput, { all: true, approval }).length === 0,
    ).toBe(mode !== "partial local");
  },
  10_000,
);
type BrowserFixture = Awaited<ReturnType<typeof browserFixture>>;
test.each(["missing", "POST", "callback", "bad POST", "bad callback"])(
  "reopened lane opener authority: %s",
  async (mode) => {
    let verified = 0;
    const f = await browserFixture("all", undefined, async () => {
      verified++;
      return ownerProof();
    });
    try {
      const callback = mode.endsWith("callback");
      const back = callback ? await laneReturn(f) : undefined;
      for (const sql of mode === "missing" ? OLD_LANE_SCHEMA : OLD_SCHEMA)
        f.db.run(sql);
      const schema = f.schema(),
        was = f.snapshot(),
        spent = [...f.spent];
      f.reopen(mode.startsWith("bad") ? await badOpener("public") : Project);
      const reply = back
        ? await f.browser(back.path, undefined, { Cookie: back.cookie })
        : await f.submit();
      expect(reply.status).toBe(
        mode === "missing" ? 503 : callback ? 200 : 302,
      );
      if (mode === "missing") {
        expect(JSON.parse(reply.text)).toMatchObject({
          error: { code: "UNAVAILABLE" },
        });
        expect(f.snapshot()).toBe(was);
        expect([...f.spent]).toEqual(spent);
        expect([f.begun.length, verified]).toEqual([0, 0]);
      }
      const assertAuthority = () => {
        expect(setupCalls(f.calls)).toEqual([]);
        expect(f.schema()).toBe(schema);
      };
      if (mode.startsWith("bad")) expect(assertAuthority).toThrow("toEqual");
      else {
        assertAuthority();
        const write = () =>
          f.send(call("lane.stop", { all: true }, "after-public"));
        f.calls.length = 0;
        expect((await write()).status).toBe(200);
        expect(setupCalls(f.calls).length).toBeGreaterThan(0);
        f.calls.length = 0;
        expect((await write()).status).toBe(200);
        expect(setupCalls(f.calls)).toEqual([]);
      }
    } finally {
      f.close();
    }
  },
  30_000,
);
async function laneReturn(
  f: BrowserFixture,
  action = "approve",
  code = "owner",
) {
  const start = await f.submit(action);
  expect(start.status).toBe(302);
  return {
    path: `/callback?state=${f.begun.at(-1)!.state}&code=${code}`,
    cookie: pageCookie(start),
  };
}

test.each([
  "approve all",
  "deny all",
  "approve issue",
  "deny issue",
  "hostile headers",
])(
  "lane callback records only the owner decision: %s",
  async (mode) => {
    const verified: string[] = [];
    const f = await browserFixture(
      mode.endsWith("issue") ? "issue" : "all",
      undefined,
      async (_request, _at, verifier) => {
        verified.push(verifier);
        return ownerProof();
      },
    );
    try {
      const action = mode.startsWith("deny") ? "deny" : "approve";
      const back = await laneReturn(f, action);
      const before = [
        f.owner.get("forge/work", "lane-control:global"),
        f.owner.get("forge/work", "lane-control:work-7"),
      ];
      const reply = await f.browser(
        back.path,
        undefined,
        {
          Cookie: back.cookie,
          Host: "evil.example",
          Origin: "https://evil.example",
          "X-Forwarded-Host": "evil.example",
        },
        true,
      );
      expect(reply.status).toBe(200);
      expect(reply.text).toContain(
        action === "approve" ? "approved" : "denied",
      );
      expect(reply.text).not.toContain("evil.example");
      expect(reply.headers.get("location")).toBeNull();
      expect(reply.headers.get("cache-control")).toBe("no-store");
      expect(approvalRows(f)[0]).toMatchObject({
        status: action === "approve" ? "approved" : "denied",
        expiresAt: f.pending.expiresAt,
        decision: {
          issuer: ownerClaims.issuer,
          subject: ownerClaims.subject,
          at: new Date(now).toISOString(),
        },
      });
      expect([
        f.owner.get("forge/work", "lane-control:global"),
        f.owner.get("forge/work", "lane-control:work-7"),
      ]).toEqual(before);
      expect(verified).toEqual([f.begun[0]!.verifier]);
      const decided = f.snapshot();
      expect(
        (await f.browser(back.path, undefined, { Cookie: back.cookie }, true))
          .status,
      ).toBe(400);
      expect(f.snapshot()).toBe(decided);
      expect(verified).toHaveLength(1);
    } finally {
      f.close();
    }
  },
  10_000,
);

test.each([
  "subject",
  "issuer",
  "audience",
  "expired identity",
  "future identity",
  "unbranded",
  "exchange failure",
  "invalid proof",
  "missing cookie",
  "foreign cookie",
  "device cookie",
  "duplicate cookie",
  "duplicate state",
  "device state",
  "expired state",
  "post",
])(
  "lane callback refuses %s without recording a decision",
  async (mode) => {
    let calls = 0;
    const f = await browserFixture("all", undefined, async () => {
      calls++;
      if (mode === "exchange failure")
        throw new Error("Injected exchange failure");
      if (mode === "invalid proof")
        return { ok: false, reason: "invalid_proof" };
      if (mode === "unbranded")
        return { ok: true, identity: ownerClaims } as IdentityResult;
      return ownerProof({
        ...(mode === "subject" ? { subject: "user_Other2" } : {}),
        ...(mode === "issuer" ? { issuer: "https://other.example" } : {}),
        ...(mode === "audience" ? { audience: "other" } : {}),
        ...(mode === "expired identity" ? { expiresAt: now } : {}),
        ...(mode === "future identity" ? { authenticatedAt: now + 1 } : {}),
      });
    });
    try {
      const back = await laneReturn(f);
      let cookie = back.cookie,
        path = back.path;
      if (mode === "missing cookie") cookie = "";
      if (mode === "foreign cookie")
        cookie = back.cookie.split("=")[0] + "=" + "x".repeat(43);
      if (mode === "device cookie")
        cookie = back.cookie.replace("forge_lane_", "forge_device_");
      if (mode === "duplicate cookie") cookie += `; ${cookie}`;
      if (mode === "duplicate state") path += `&state=${f.begun[0]!.state}`;
      if (mode === "device state")
        path = path.replace("forge-lane.", "forge-device.");
      if (mode === "expired state") f.clock.mockReturnValue(now + 600_000);
      const before = f.snapshot();
      const reply = await f.browser(
        path,
        mode === "post" ? "" : undefined,
        { Cookie: cookie, "CF-Connecting-IP": "203.0.113.1" },
        true,
      );
      expect(reply.status).toBe(400);
      expect(f.snapshot()).toBe(before);
      expect(approvalRows(f)[0]!.status).toBe("pending");
      if (
        mode.includes("cookie") ||
        ["duplicate state", "device state", "expired state", "post"].includes(
          mode,
        )
      )
        expect(calls).toBe(0);
    } finally {
      f.close();
    }
  },
  10_000,
);

test.each(
  ["claim", "exchange"].flatMap((phase) =>
    [
      "expiry",
      "epoch",
      "incarnation",
      "owner",
      "issuer",
      "audience",
      "revoke",
      "token expiry",
      "device",
      "session",
    ].map((change) => [phase, change] as const),
  ),
)(
  "lane callback rechecks after %s await: %s",
  async (phase, change) => {
    let mutate = () => {},
      calls = 0;
    const f = await browserFixture("all", undefined, async () => {
      calls++;
      const proof = await ownerProof();
      if (phase === "exchange") mutate();
      return proof;
    });
    try {
      const back = await laneReturn(f);
      let expected = "";
      mutate = () => {
        if (change === "expiry") f.clock.mockReturnValue(now + 600_000);
        if (change === "epoch" || change === "incarnation") {
          const old = f.owner.get("forge/work", "lane-control:global")!;
          f.owner.put(
            "forge/work",
            old.key,
            {
              ...(old.value as object),
              ...(change === "epoch"
                ? { epoch: 99 }
                : { incarnation: "replacement" }),
            },
            actor,
            { expectRevision: old.revision },
          );
        }
        if (change === "owner") f.env.FORGE_OWNER_SUBJECT = "user_Other2";
        if (change === "issuer") f.env.CLERK_ISSUER = "https://other.example";
        if (change === "audience") f.env.CLERK_CLIENT_ID = "other";
        if (change === "revoke")
          f.db.run("UPDATE domain_cloud_tokens SET revoked_at=?", [now]);
        if (change === "token expiry")
          f.db.run("UPDATE domain_cloud_tokens SET expires_at=?", [now]);
        if (change === "device")
          f.db.run("UPDATE domain_cloud_tokens SET device='other'");
        if (change === "session")
          f.db.run("UPDATE domain_cloud_tokens SET session='other'");
        expected = f.snapshot();
      };
      if (phase === "claim") f.duringClaim(mutate);
      expect(
        (await f.browser(back.path, undefined, { Cookie: back.cookie }, true))
          .status,
      ).toBe(400);
      expect(f.snapshot()).toBe(expected);
      expect(approvalRows(f)[0]!.status).toBe("pending");
      expect(calls).toBe(phase === "claim" ? 0 : 1);
    } finally {
      f.close();
    }
  },
  10_000,
);

test.each([
  "same state",
  "opposite actions",
  "same code after failure",
  "write failure",
])(
  "lane callback atomicity: %s",
  async (mode) => {
    let calls = 0;
    const f = await browserFixture("all", undefined, async () => {
      calls++;
      const proof = await ownerProof();
      return mode === "same code after failure"
        ? { ok: false, reason: "invalid_proof" }
        : proof;
    });
    try {
      const first = await laneReturn(f),
        before = f.snapshot();
      const second =
        mode === "same state" || mode === "write failure"
          ? first
          : await laneReturn(
              f,
              "deny",
              mode === "same code after failure" ? "owner" : "other-code",
            );
      if (mode === "write failure")
        f.db.run(
          `CREATE TRIGGER refuse_decision BEFORE UPDATE ON ${LANE_APPROVALS} BEGIN SELECT RAISE(ABORT, 'injected decision failure'); END`,
        );
      const returns = [first, second].map(
        (back) => () =>
          f.browser(back.path, undefined, { Cookie: back.cookie }, true),
      );
      const replies =
        mode === "same code after failure"
          ? [await returns[0]!(), await returns[1]!()]
          : await Promise.all(returns.map((run) => run()));
      if (mode === "write failure") {
        expect(replies.every((reply) => reply.status >= 400)).toBe(true);
        expect(f.snapshot()).toBe(before);
      } else if (mode === "same code after failure") {
        expect(replies.map((reply) => reply.status)).toEqual([400, 400]);
        expect(calls).toBe(1);
        expect(f.snapshot()).toBe(before);
      } else {
        expect(replies.map((reply) => reply.status).sort()).toEqual([200, 400]);
        expect(
          approvalRows(f).filter((row) =>
            ["approved", "denied"].includes(row.status),
          ),
        ).toHaveLength(1);
      }
    } finally {
      f.close();
    }
  },
  10_000,
);

test.each(["https://identity.example", "https://other-clerk.example:8443/"])(
  "lane preview CSP allows exactly the configured Clerk origin %s",
  async (issuer) => {
    const f = await browserFixture("all", issuer);
    try {
      const page = await f.browser(f.path, undefined, {
        Host: "evil.example",
        Origin: "https://evil.example",
        "X-Forwarded-Host": "evil.example",
      });
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toBe(
        `default-src 'none'; form-action 'self' ${new URL(issuer).origin}; frame-ancestors 'none'`,
      );
    } finally {
      f.close();
    }
  },
  10_000,
);

test.each(["approve", "deny"])(
  "repeated %s starts on one request leave capacity for another",
  async (action) => {
    const f = await browserFixture();
    try {
      const other = await f.send(
        call("lane.resume", { all: true }, "other-browser-ask"),
      );
      expect(other.verdict).toEqual(["FAIL", "APPROVAL_REQUIRED", 1]);
      expect(other.status).toBe(409);
      const otherId = (
        other.envelope as unknown as { result: { request: string } }
      ).result.request;
      seedLegacyApproval(f, otherId);
      for (let n = 0; n < 257; n++) {
        const page = await f.browser(f.path);
        const reply = await f.browser(
          `${f.path}/${action}`,
          new URLSearchParams({ ticket: pageTicket(page, action) }).toString(),
          { Origin: "https://w.example", Cookie: pageCookie(page) },
        );
        expect(reply.status).toBe(302);
      }
      const path = `/lane-approval/${otherId}`;
      const page = await f.browser(path);
      const reply = await f.browser(
        `${path}/${action}`,
        new URLSearchParams({ ticket: pageTicket(page, action) }).toString(),
        { Origin: "https://w.example", Cookie: pageCookie(page) },
      );
      expect(reply.status).toBe(302);
      const stored = f.db
        .query("SELECT state FROM domain_cloud_lane_browser WHERE id=1")
        .get() as { state: string };
      const states = JSON.parse(stored.state) as {
        request: string;
        action: string;
      }[];
      expect(states.map((entry) => [entry.request, entry.action])).toEqual([
        [f.pending.request, action],
        [otherId, action],
      ]);
    } finally {
      f.close();
    }
  },
  10_000,
);

test.each(
  ["approve", "deny"].flatMap((action) =>
    ["cancelled", "failed upstream"].map((mode) => [action, mode] as const),
  ),
)(
  "reloading the same browser permits a new %s start after %s",
  async (action, mode) => {
    const f = await browserFixture();
    try {
      const oldTicket = pageTicket(f.shown, action);
      if (mode === "failed upstream")
        f.duringBegin(() => {
          throw new Error("Injected upstream start failure");
        });
      expect((await f.submit(action)).status).toBe(
        mode === "failed upstream" ? 503 : 302,
      );
      f.duringBegin(() => {});
      const before = f.snapshot(),
        writes = f.writes();
      const reloaded = await f.browser(f.path, undefined, { Cookie: f.cookie });
      expect(reloaded.status).toBe(200);
      expect(pageCookie(reloaded)).toBe(f.cookie);
      expect([f.snapshot(), f.writes()]).toEqual([before, writes]);
      const newTicket = pageTicket(reloaded, action);
      expect(newTicket).toMatch(/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
      expect(newTicket).not.toBe(oldTicket);
      expect((await f.submit(action, newTicket)).status).toBe(302);
      expect((await f.submit(action, oldTicket)).status).toBe(400);
      expect(f.begun).toHaveLength(2);
    } finally {
      f.close();
    }
  },
  10_000,
);
