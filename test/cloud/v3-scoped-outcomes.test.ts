import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import {
  type ReceiptPrincipal,
  receiptScope,
  scopeRequestId,
} from "../../cloud/src/issue-request-id.ts";
import { createWorker } from "../../cloud/src/worker.ts";
import { canonicalJson, digestBytes } from "../../src/core/config/pointer.ts";
import {
  fixture,
  guardFixture,
  noWrites,
  probe,
  sqlMutation,
} from "./v3-project.fixture.ts";

const timeout = 30_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = Date.parse("2026-11-20T12:00:00.000Z");
const E1 = T0 + 2 * HOUR;
const EXPIRED = E1 + 1;
const E2 = T0 + 24 * HOUR;
const holder = {
  actor: { kind: "agent", id: "fixture" },
  session: { id: "fixture" },
};

beforeEach(() => setSystemTime(T0));
afterEach(() => setSystemTime());

interface Step {
  readonly route: "claim" | "renew" | "release";
  readonly requestId: string;
  readonly expect: number | string;
  readonly writes: number;
  readonly owner?: string;
  readonly at?: number;
  readonly expires?: number;
  readonly ttlMs?: number;
  readonly generation?: number;
  readonly restart?: true;
  readonly expired?: true;
}

const headers = (owner: string, expires: number) => ({
  "X-Forge-Owner": owner,
  "X-Forge-Owner-Expires": String(expires),
});

const leaseBody = (step: Omit<Step, "expect" | "writes">) => ({
  subject: "work-1",
  requestId: step.requestId,
  holder,
  ...(step.route === "claim" ? {} : { generation: step.generation ?? 1 }),
  ...(step.route === "release" ? {} : { ttlMs: step.ttlMs ?? HOUR }),
});

async function run(store: "v2" | "v3", steps: readonly Step[]) {
  let writes = 0;
  const f = fixture((sql) => {
    if (sqlMutation.test(sql)) writes++;
  });
  try {
    if (store === "v3") expect((await f.send(probe, {})).status).toBe(200);
    else f.restart(false);
    const frames = () =>
      store === "v3"
        ? f.db
            .query<{ n: number }, []>(
              "SELECT COUNT(*) AS n FROM cloud_v3_commits",
            )
            .get()!.n
        : 0;
    const results = [];
    for (const step of steps) {
      setSystemTime(step.at ?? T0);
      if (step.restart || step.expired) f.restart(store === "v3");
      const alarms = f.alarms.length;
      const kv = JSON.stringify([...f.values]);
      const committed = frames();
      writes = 0;
      const response = await f.send(
        store === "v3" ? `${probe}/${step.route}` : step.route,
        leaseBody(step),
        headers(step.owner ?? "owner-a", step.expires ?? E1),
      );
      results.push({
        ...response,
        writes,
        committed: frames() - committed,
        alarmWrites: f.alarms.length - alarms,
        kvIntact: kv === JSON.stringify([...f.values]),
      });
    }
    return results;
  } finally {
    f.db.close();
  }
}

const decided = (body: unknown) => {
  const { value, error } = body as {
    value?: { generation?: unknown };
    error?: { code?: unknown };
  };
  return value?.generation ?? error?.code;
};

async function scenario(steps: readonly Step[]) {
  const v2 = await run("v2", steps);
  expect(v2.map(({ body }) => decided(body))).toEqual(
    steps.map((step) => step.expect),
  );
  const v3 = await run("v3", steps);
  expect(v3).toEqual(
    v2.map(({ status, body }, i) => ({
      status,
      body,
      writes: steps[i]!.writes,
      committed: steps[i]!.writes,
      alarmWrites: 0,
      kvIntact: true,
    })),
  );
  return v3;
}

test(
  "an admitted v3 outcome replays after restart on every lease route with zero writes",
  async () => {
    const v3 = await scenario([
      { route: "claim", requestId: "acq-1", expect: 1, writes: 1 },
      {
        route: "claim",
        requestId: "acq-1",
        expect: 1,
        writes: 0,
        restart: true,
      },
      {
        route: "renew",
        requestId: "ren-1",
        expect: 1,
        writes: 1,
        at: T0 + 10 * MINUTE,
      },
      {
        route: "renew",
        requestId: "ren-1",
        expect: 1,
        writes: 0,
        at: T0 + 11 * MINUTE,
        restart: true,
      },
      {
        route: "claim",
        requestId: "acq-1",
        expect: 1,
        writes: 0,
        at: T0 + 12 * MINUTE,
      },
      {
        route: "release",
        requestId: "rel-1",
        expect: 1,
        writes: 1,
        at: T0 + 20 * MINUTE,
      },
      {
        route: "release",
        requestId: "rel-1",
        expect: 1,
        writes: 0,
        at: T0 + 21 * MINUTE,
        restart: true,
      },
      {
        route: "renew",
        requestId: "ren-1",
        expect: "LEASE_STALE",
        writes: 0,
        at: T0 + 22 * MINUTE,
      },
      {
        route: "claim",
        requestId: "acq-1",
        expect: "LEASE_STALE",
        writes: 0,
        at: T0 + 22 * MINUTE,
      },
    ]);
    const value = (i: number) =>
      (v3[i]!.body as { value?: { expiresAt?: string } }).value;
    expect(value(4)).toEqual(value(2));
    expect([value(2)?.expiresAt, value(0)?.expiresAt]).toEqual([
      new Date(T0 + 70 * MINUTE).toISOString(),
      new Date(T0 + HOUR).toISOString(),
    ]);
  },
  timeout,
);

test(
  "changed input under a v3 request ID is refused exactly as v2 refuses it, with zero writes",
  () =>
    scenario([
      { route: "claim", requestId: "acq-1", expect: 1, writes: 1 },
      {
        route: "claim",
        requestId: "acq-1",
        expect: "INPUT_CONFLICT",
        writes: 0,
        ttlMs: 30 * MINUTE,
        restart: true,
      },
      { route: "renew", requestId: "ren-1", expect: 1, writes: 1 },
      {
        route: "renew",
        requestId: "ren-1",
        expect: "INPUT_CONFLICT",
        writes: 0,
        ttlMs: 30 * MINUTE,
      },
      { route: "release", requestId: "rel-1", expect: 1, writes: 1 },
      {
        route: "release",
        requestId: "rel-1",
        expect: "INPUT_CONFLICT",
        writes: 0,
        generation: 2,
        restart: true,
      },
    ]),
  timeout,
);

test(
  "the same raw request ID from another owner is its own scope and gains no authority",
  () =>
    scenario([
      { route: "claim", requestId: "acq-1", expect: 1, writes: 1 },
      {
        route: "claim",
        requestId: "acq-1",
        owner: "owner-b",
        expect: "LEASE_HELD",
        writes: 1,
      },
      {
        route: "claim",
        requestId: "acq-1",
        owner: "owner-b",
        expect: "LEASE_HELD",
        writes: 0,
        restart: true,
      },
      { route: "claim", requestId: "acq-1", expect: 1, writes: 0 },
    ]),
  timeout,
);

test(
  "after its receipt expires, a released acquisition ID gets the lease refusal with no append and no new generation",
  () =>
    scenario([
      { route: "claim", requestId: "acq-1", expect: 1, writes: 1 },
      {
        route: "release",
        requestId: "rel-1",
        expect: 1,
        writes: 1,
        at: T0 + MINUTE,
      },
      {
        route: "claim",
        requestId: "acq-1",
        expect: "LEASE_NOT_HELD",
        writes: 0,
        at: EXPIRED,
        expires: E2,
        expired: true,
      },
      {
        route: "claim",
        requestId: "acq-2",
        expect: 2,
        writes: 1,
        at: EXPIRED,
        expires: E2,
      },
    ]),
  timeout,
);

test(
  "after its receipt expires, the held generation is checked before the input fingerprint",
  () =>
    scenario([
      { route: "claim", requestId: "acq-1", expect: 1, writes: 1 },
      {
        route: "release",
        requestId: "rel-1",
        expect: 1,
        writes: 1,
        at: T0 + MINUTE,
      },
      {
        route: "claim",
        requestId: "acq-1",
        expect: "LEASE_NOT_HELD",
        writes: 0,
        at: EXPIRED,
        expires: E2,
        ttlMs: 30 * MINUTE,
        expired: true,
      },
    ]),
  timeout,
);

test(
  "after its receipt expires, an expired acquisition ID cannot revive its lease",
  () =>
    scenario([
      { route: "claim", requestId: "acq-1", expect: 1, writes: 1 },
      {
        route: "claim",
        requestId: "acq-1",
        expect: "LEASE_EXPIRED",
        writes: 0,
        at: EXPIRED,
        expires: E2,
        expired: true,
      },
    ]),
  timeout,
);

test(
  "after its receipt expires, a replaced acquisition ID gets the stale lease refusal",
  () =>
    scenario([
      { route: "claim", requestId: "acq-1", expect: 1, writes: 1 },
      {
        route: "claim",
        requestId: "acq-b",
        owner: "owner-b",
        expect: 2,
        writes: 1,
        at: T0 + HOUR + MINUTE,
        expires: E2,
      },
      {
        route: "claim",
        requestId: "acq-1",
        expect: "LEASE_STALE",
        writes: 0,
        at: EXPIRED,
        expires: E2,
        expired: true,
      },
    ]),
  timeout,
);

test(
  "after its receipt expires, a still-held acquisition ID keeps its fingerprint and recorded grant with zero writes",
  () =>
    scenario([
      { route: "claim", requestId: "acq-1", expect: 1, writes: 1 },
      {
        route: "renew",
        requestId: "ren-1",
        expect: 1,
        writes: 1,
        at: T0 + 30 * MINUTE,
        expires: E2,
        ttlMs: 23 * HOUR,
      },
      {
        route: "claim",
        requestId: "acq-1",
        expect: "INPUT_CONFLICT",
        writes: 0,
        at: EXPIRED,
        expires: E2,
        ttlMs: 2 * HOUR,
        expired: true,
      },
      {
        route: "claim",
        requestId: "acq-1",
        expect: 1,
        writes: 0,
        at: EXPIRED,
        expires: E2,
      },
    ]),
  timeout,
);

test(
  "a v3 claim frame carries its exact scope, outcome and acquisition witness, and a refusal frame carries neither lease nor witness",
  async () => {
    const f = fixture();
    try {
      expect((await f.send(probe, {})).status).toBe(200);
      const claim = (owner: string) =>
        f.send(
          `${probe}/claim`,
          leaseBody({ route: "claim", requestId: "acq-1" }),
          headers(owner, E1),
        );
      const granted = await claim("owner-a");
      setSystemTime(T0 + MINUTE);
      const refused = await claim("owner-b");
      const scoped = (owner: string) => {
        const principal: ReceiptPrincipal = ["owner", owner, owner];
        const leaseHolder = {
          ...holder,
          session: { id: "fixture", device: owner },
        };
        const fingerprint = canonicalJson({
          scope: receiptScope(principal),
          route: "claim",
          subject: "work-1",
          holder: leaseHolder,
          generation: null,
          ttlMs: HOUR,
        });
        return {
          leaseHolder,
          fingerprint,
          outcome: {
            id: scopeRequestId("lease", principal, "acq-1"),
            scope: { family: "lease", ...receiptScope(principal) },
            fingerprint,
          },
        };
      };
      const a = scoped("owner-a");
      const b = scoped("owner-b");
      const grant = {
        subject: "work-1",
        holder: a.leaseHolder,
        generation: 1,
        expiresAt: new Date(T0 + HOUR).toISOString(),
      };
      expect(granted).toEqual({
        status: 200,
        body: { ok: true, value: grant },
      });
      expect(refused).toMatchObject({
        status: 409,
        body: { ok: false, error: { code: "LEASE_HELD" } },
      });
      const frames = f.db
        .query<{ body: string }, []>(
          "SELECT body FROM cloud_v3_commits ORDER BY sequence",
        )
        .all()
        .map(({ body }) => JSON.parse(body) as unknown);
      expect(frames).toEqual([
        {
          format: "forge-cloud-commit/3",
          sequence: 1,
          operation: "lease.claim",
          time: T0,
          events: [],
          lease: grant,
          outcome: { ...a.outcome, status: "ok", retryUntil: E1 },
          witness: {
            namespace: "forge/work",
            id: a.outcome.id,
            subject: "work-1",
            generation: 1,
            digest: digestBytes(a.fingerprint),
          },
        },
        {
          format: "forge-cloud-commit/3",
          sequence: 2,
          operation: "lease.claim",
          time: T0 + MINUTE,
          events: [],
          outcome: {
            ...b.outcome,
            status: "LEASE_HELD",
            result: (refused.body as { error: unknown }).error,
            retryUntil: E1,
          },
        },
      ]);
    } finally {
      f.db.close();
    }
  },
  timeout,
);

for (const field of ["lease", "outcome", "witness"] as const) {
  test(
    `a synthetic v3 frame carrying ${field} is refused before any write`,
    async () => {
      const f = guardFixture();
      try {
        expect((await f.send(probe, {})).status).toBe(200);
        const effects = f.observeEffects();
        const { status, body } = await f.send(`${probe}/commits`, {
          frames: [
            {
              operation: "lease.claim",
              time: T0,
              events: [],
              [field]: { id: "acq-1", subject: "work-1", generation: 1 },
            },
          ],
        });
        expect({ status, body, ...effects() }).toEqual({
          status: 400,
          body: {
            ok: false,
            error: {
              code: "INPUT_INVALID",
              message: "Invalid v3 frame",
              retry: "never",
            },
          },
          ...noWrites,
        });
      } finally {
        f.db.close();
      }
    },
    timeout,
  );
}

const boundaries = [
  ["empty storage", "empty", headers("owner-a", E1), {}, "UNAVAILABLE"],
  ["v2 storage", "v2", headers("owner-a", E1), {}, "UNAVAILABLE"],
  ["a missing owner", "v3", {}, {}, "AUTH_REQUIRED"],
  ["an expired owner", "v3", headers("owner-a", T0), {}, "AUTH_EXPIRED"],
  [
    "another device",
    "v3",
    headers("owner-a", E1),
    { holder: { ...holder, session: { id: "fixture", device: "other" } } },
    "AUTH_DEVICE_MISMATCH",
  ],
] as const;

for (const [label, store, owner, change, code] of boundaries) {
  test(
    `the v3 lease route refuses ${label} before any write`,
    async () => {
      const f = guardFixture();
      try {
        if (store === "v3") expect((await f.send(probe, {})).status).toBe(200);
        if (store === "v2") {
          f.restart(false);
          expect(
            (await f.send("devices", { device: "fixture", ttlMs: 60_000 }))
              .status,
          ).toBe(200);
          f.restart();
        }
        const effects = f.observeEffects();
        const { body } = await f.send(
          `${probe}/claim`,
          { ...leaseBody({ route: "claim", requestId: "acq-1" }), ...change },
          owner,
        );
        const error = (body as { error?: { code?: unknown } }).error;
        expect({ code: error?.code, ...effects() }).toEqual({
          code,
          ...noWrites,
        });
      } finally {
        f.db.close();
      }
    },
    timeout,
  );
}

test(
  "the public Worker cannot forward the v3 lease route",
  async () => {
    const f = fixture();
    try {
      const response = await createWorker().fetch(
        f.request(
          `${probe}/claim`,
          leaseBody({ route: "claim", requestId: "acq-1" }),
          headers("owner-a", E1),
        ),
        {
          PROJECTS: {
            idFromName: () => {
              throw new Error("The public Worker resolved the private probe");
            },
            get: () => {
              throw new Error("The public Worker opened the private probe");
            },
          },
        },
      );
      expect(response.status).toBe(404);
    } finally {
      f.db.close();
    }
  },
  timeout,
);
