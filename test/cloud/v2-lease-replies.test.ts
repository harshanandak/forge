import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { storageOf } from "../../cloud/conformance/storage.ts";
import { Project } from "../../cloud/src/project.ts";
import type { ForgeError, LeaseRecord } from "../../src/generated/types.ts";
import { exitCode } from "../../src/surface/result.ts";

const timeout = 30_000;
const time = Date.parse("2026-11-20T12:00:00.000Z");
const ttlMs = 3_600_000;
const owner = "owner-a";
const subject = "issue:work-1";
const holder = {
  actor: { kind: "agent", id: "fixture" },
  session: { id: "fixture" },
};
const states = ["warm", "reopened"] as const;
type State = (typeof states)[number];
type Route = "claim" | "renew" | "release";
type Reply = { status: number; text: string };
type Expected =
  | { status: 200; value: LeaseRecord }
  | { status: 400 | 409; error: ForgeError; exit: 4 | 6 };
type LeaseCase = {
  name: string;
  route: Route;
  input: { ttlMs?: number; generation?: number };
  device?: string;
  claimFirst?: boolean;
  expected: Expected;
};

beforeEach(() => setSystemTime(time));
afterEach(() => setSystemTime());

function fixture(db: Database) {
  const ctx = storageOf(db);
  let project = new Project(ctx);

  async function send(route: Route, input: object, device = owner) {
    const response = await project.fetch(
      new Request(`https://fixture.example/p/a/${route}`, {
        method: "POST",
        headers: {
          "X-Forge-Owner": device,
          "X-Forge-Owner-Expires": String(time + 2 * ttlMs),
        },
        body: JSON.stringify({ subject, holder, ...input }),
      }),
    );
    return { status: response.status, text: await response.text() };
  }

  const snapshot = () => ({
    leases: db
      .query("SELECT * FROM state_leases ORDER BY namespace, subject")
      .all(),
    events: db.query("SELECT * FROM state_events ORDER BY sequence").all(),
    acquisitions: db
      .query("SELECT * FROM state_requests ORDER BY namespace, request_id")
      .all(),
    receipts: db
      .query("SELECT * FROM domain_cloud_requests ORDER BY request_id")
      .all(),
    commandReceipts: db
      .query("SELECT * FROM domain_cloud_command_receipts ORDER BY request_id")
      .all(),
  });
  return {
    send,
    snapshot,
    reopen: () => {
      project = new Project(ctx);
    },
  };
}

const claimed = {
  subject: "issue:work-1",
  holder: {
    actor: { kind: "agent", id: "fixture" },
    session: { id: "fixture", device: "owner-a" },
  },
  generation: 1,
  expiresAt: "2026-11-20T13:00:00.000Z",
} satisfies LeaseRecord;
const released = { ...claimed, releasedAt: "2026-11-20T12:00:00.000Z" };
const success = (value: LeaseRecord): Expected => ({ status: 200, value });
const conflict = (error: ForgeError): Expected => ({
  status: 409,
  error,
  exit: 4,
});

function expectLeaseReply(reply: Reply, expected: Expected) {
  expect(reply.status).toBe(expected.status);
  const body: unknown = JSON.parse(reply.text);
  if ("value" in expected) {
    expect(body).toEqual({ ok: true, value: expected.value });
  } else {
    expect(body).toEqual({ ok: false, error: expected.error });
    const { error } = body as { error: ForgeError };
    expect(exitCode({ ok: false, status: "FAIL", error, warnings: [] })).toBe(
      expected.exit,
    );
  }
}

type Fixture = ReturnType<typeof fixture>;
const seed = { requestId: "setup-claim", ttlMs };
async function seedClaim(f: Fixture) {
  expectLeaseReply(await f.send("claim", seed), success(claimed));
}

async function replayReply(
  f: Fixture,
  send: () => Promise<Reply>,
  expected: Expected,
) {
  const before = f.snapshot();
  const reply = await send();
  expectLeaseReply(reply, expected);
  expect(f.snapshot()).toEqual(before);
  return reply;
}

async function leaseReplies(state: State, row: LeaseCase) {
  using db = new Database(":memory:");
  const f = fixture(db);
  if (row.claimFirst) await seedClaim(f);
  const send = () =>
    f.send(row.route, { requestId: "attempt", ...row.input }, row.device);
  const first = await send();
  expectLeaseReply(first, row.expected);
  if (state === "reopened") f.reopen();
  const replay = await replayReply(f, send, row.expected);
  return { first, replay };
}

const successes: readonly LeaseCase[] = [
  {
    name: "claim",
    route: "claim",
    input: { ttlMs },
    expected: success(claimed),
  },
  {
    name: "renew",
    route: "renew",
    input: { generation: 1, ttlMs: ttlMs / 2 },
    claimFirst: true,
    expected: success({ ...claimed, expiresAt: "2026-11-20T12:30:00.000Z" }),
  },
  {
    name: "release",
    route: "release",
    input: { generation: 1 },
    claimFirst: true,
    expected: success(released),
  },
];

const refusals: readonly LeaseCase[] = [
  {
    name: "LEASE_HELD",
    route: "claim",
    input: { ttlMs },
    device: "owner-b",
    claimFirst: true,
    expected: conflict({
      code: "LEASE_HELD",
      message:
        "issue:work-1 is leased by device owner-a, agent fixture, harness unspecified, session fixture until 2026-11-20T13:00:00.000Z; read its state to reconcile instead of retrying",
      retry: "reconcile_first",
      lease: claimed,
    }),
  },
  {
    name: "LEASE_NOT_HELD",
    route: "renew",
    input: { generation: 1, ttlMs },
    expected: conflict({
      code: "LEASE_NOT_HELD",
      message: "issue:work-1 has no lease",
      retry: "reconcile_first",
      lease: { subject: "issue:work-1" },
    }),
  },
  {
    name: "LEASE_STALE",
    route: "renew",
    input: { generation: 2, ttlMs },
    claimFirst: true,
    expected: conflict({
      code: "LEASE_STALE",
      message: "generation 2 is not the current generation 1 of issue:work-1",
      retry: "reconcile_first",
      lease: claimed,
    }),
  },
];

const invalidTtl: LeaseCase = {
  name: "INPUT_INVALID",
  route: "claim",
  input: { ttlMs: 0 },
  expected: {
    status: 400,
    exit: 6,
    error: {
      code: "INPUT_INVALID",
      message: "ttlMs must be a positive safe integer",
      retry: "never",
    },
  },
};

for (const state of states) {
  for (const row of [...successes, ...refusals, invalidTtl]) {
    test(
      `v2 ${state} ${row.name} replay keeps its first reply text`,
      async () => {
        const { first, replay } = await leaseReplies(state, row);
        expect(replay.text).toBe(first.text);
      },
      timeout,
    );
  }
  for (const row of [...successes, ...refusals]) {
    test(
      `v2 ${state} ${row.name} replay preserves reply values`,
      async () => {
        await leaseReplies(state, row);
      },
      timeout,
    );
  }

  test(
    `v2 ${state} rejects changed input under the same request id`,
    async () => {
      using db = new Database(":memory:");
      const f = fixture(db);
      await seedClaim(f);
      if (state === "reopened") f.reopen();
      const send = () => f.send("claim", { ...seed, ttlMs: ttlMs / 2 });
      const expected = conflict({
        code: "INPUT_CONFLICT",
        message: "Request ID belongs to a different input",
        retry: "reconcile_first",
      });
      const first = await replayReply(f, send, expected);
      const second = await replayReply(f, send, expected);
      expect(second.text).toBe(first.text);
    },
    timeout,
  );

  test(
    `v2 ${state} refuses a replay after release`,
    async () => {
      using db = new Database(":memory:");
      const f = fixture(db);
      await seedClaim(f);
      expectLeaseReply(
        await f.send("release", { requestId: "release", generation: 1 }),
        success(released),
      );
      if (state === "reopened") f.reopen();
      const send = () => f.send("claim", seed);
      const expected = conflict({
        code: "LEASE_STALE",
        message:
          "Request l2:862cf587c88f9531b7caa135b1f26da1ab479ae099153d37c23c24d9399a82a9 no longer matches the current lease on issue:work-1",
        retry: "reconcile_first",
        lease: claimed,
      });
      const first = await replayReply(f, send, expected);
      const second = await replayReply(f, send, expected);
      expect(second.text).toBe(first.text);
    },
    timeout,
  );
}
