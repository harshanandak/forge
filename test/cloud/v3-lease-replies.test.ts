import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import type { ForgeError, LeaseRecord } from "../../src/generated/types.ts";
import {
  expectTypedReply,
  guardFixture,
  probe,
  readOnlyReply,
  typedReplyCases,
} from "./v3-project.fixture.ts";

const timeout = 30_000;
const time = Date.parse("2026-11-20T12:00:00.000Z");
const ttlMs = 3_600_000;
const owner = "owner-a";
const subject = "issue:work-1";
const holder = {
  actor: { kind: "agent", id: "fixture" },
  session: { id: "fixture" },
};
const headers = (device = owner) => ({
  "X-Forge-Owner": device,
  "X-Forge-Owner-Expires": String(time + 2 * ttlMs),
});
const states = ["warm", "cold tail", "cold pages"] as const;
type State = (typeof states)[number];
type Fixture = ReturnType<typeof guardFixture>;
type RawReply = Awaited<ReturnType<Fixture["sendText"]>>;
type LeaseCase = {
  name: string;
  route: "claim" | "renew" | "release";
  input: object;
  device?: string;
  claimFirst?: boolean;
  expected:
    | { status: 200; value: object }
    | { status: 400 | 409; error: ForgeError; exit: number };
};

beforeEach(() => setSystemTime(time));
afterEach(() => setSystemTime());

async function prepare(f: Fixture, state: State) {
  if (state === "cold pages") {
    const view = await f.send(probe);
    expect(view.status).toBe(200);
    const { value } = view.body as {
      value: { coveredHead: number; image: { head: number } };
    };
    const head = value.image.head;
    let coveredHead = value.coveredHead;
    expect(coveredHead).toBeLessThan(head);
    while (coveredHead < head) {
      const reply = await f.send(`${probe}/checkpoint`, {});
      expect(reply.status).toBe(200);
      const { value: next } = reply.body as {
        value: { coveredHead: number; more: boolean };
      };
      expect(next.coveredHead).toBeGreaterThan(coveredHead);
      expect(next.coveredHead).toBeLessThanOrEqual(head);
      expect(next.more).toBe(next.coveredHead < head);
      coveredHead = next.coveredHead;
    }
  }
  if (state !== "warm") f.restart();
}

function expectLeaseReply(reply: RawReply, expected: LeaseCase["expected"]) {
  if ("error" in expected) {
    expectTypedReply(reply, expected);
    return;
  }
  expect(reply.status).toBe(expected.status);
  expect(JSON.parse(reply.text)).toEqual({ ok: true, value: expected.value });
}

async function leaseReplies(state: State, row: LeaseCase) {
  const f = guardFixture();
  using _db = f.db;
  expect((await f.send(probe, {})).status).toBe(200);
  if (row.claimFirst) {
    expectLeaseReply(
      await f.sendText(
        `${probe}/claim`,
        { requestId: "setup-claim", subject, holder, ttlMs },
        headers(),
      ),
      { status: 200, value: claimed },
    );
  }
  const send = () =>
    f.sendText(
      `${probe}/${row.route}`,
      { requestId: "attempt", subject, holder, ...row.input },
      headers(row.device),
    );
  const first = await send();
  expectLeaseReply(first, row.expected);
  await prepare(f, state);
  const replay = await readOnlyReply(f, send);
  expectLeaseReply(replay, row.expected);
  return { first, replay };
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
const successes: readonly LeaseCase[] = [
  {
    name: "claim",
    route: "claim",
    input: { ttlMs },
    expected: { status: 200, value: claimed },
  },
  {
    name: "renew",
    route: "renew",
    input: { generation: 1, ttlMs: ttlMs / 2 },
    claimFirst: true,
    expected: {
      status: 200,
      value: { ...claimed, expiresAt: "2026-11-20T12:30:00.000Z" },
    },
  },
  {
    name: "release",
    route: "release",
    input: { generation: 1 },
    claimFirst: true,
    expected: {
      status: 200,
      value: { ...claimed, releasedAt: "2026-11-20T12:00:00.000Z" },
    },
  },
];

const refusals: readonly LeaseCase[] = [
  {
    name: "LEASE_HELD",
    route: "claim",
    input: { ttlMs },
    device: "owner-b",
    claimFirst: true,
    expected: {
      status: 409,
      exit: 4,
      error: {
        code: "LEASE_HELD",
        message:
          "issue:work-1 is leased by device owner-a, agent fixture, harness unspecified, session fixture until 2026-11-20T13:00:00.000Z; read its state to reconcile instead of retrying",
        retry: "reconcile_first",
        lease: claimed,
      },
    },
  },
  {
    name: "LEASE_NOT_HELD",
    route: "renew",
    input: { generation: 1, ttlMs },
    expected: {
      status: 409,
      exit: 4,
      error: {
        code: "LEASE_NOT_HELD",
        message: "issue:work-1 has no lease",
        retry: "reconcile_first",
        lease: { subject: "issue:work-1" },
      },
    },
  },
  {
    name: "LEASE_STALE",
    route: "renew",
    input: { generation: 2, ttlMs },
    claimFirst: true,
    expected: {
      status: 409,
      exit: 4,
      error: {
        code: "LEASE_STALE",
        message: "generation 2 is not the current generation 1 of issue:work-1",
        retry: "reconcile_first",
        lease: claimed,
      },
    },
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
const typedEnv = { FORGE_CLOUD_PROJECT: "a", FORGE_CLOUD_ID_PREFIX: "forge" };

for (const state of states) {
  for (const row of [...successes, ...refusals, invalidTtl]) {
    test(
      `v3 ${state} ${row.name} replay keeps its first reply text`,
      async () => {
        const { first, replay } = await leaseReplies(state, row);
        expect(replay.text).toBe(first.text);
      },
      timeout,
    );
  }
  for (const row of [...successes, ...refusals]) {
    test(
      `v3 ${state} ${row.name} replay preserves reply values`,
      async () => {
        await leaseReplies(state, row);
      },
      timeout,
    );
  }
  test(
    `v3 ${state} typed NOT_FOUND replay keeps its first reply text`,
    async () => {
      const f = guardFixture(typedEnv);
      using _db = f.db;
      expect((await f.send(probe, {})).status).toBe(200);
      const { call, expected } = typedReplyCases(time, owner).missing;
      const send = () => f.sendText(`${probe}/command`, call, headers());
      const first = await send();
      expectTypedReply(first, expected);
      await prepare(f, state);
      const replay = await readOnlyReply(f, send);
      expectTypedReply(replay, expected);
      expect(replay.text).toBe(first.text);
    },
    timeout,
  );
}
