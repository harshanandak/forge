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
  readonly change?: Readonly<Record<string, unknown>>;
  readonly raw?: unknown;
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
  ...step.change,
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
        "raw" in step ? step.raw : leaseBody(step),
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
  "a recorded renew or release refusal on a fresh v3 project replays after restart with zero writes",
  () =>
    scenario([
      {
        route: "renew",
        requestId: "ren-1",
        expect: "LEASE_NOT_HELD",
        writes: 1,
      },
      {
        route: "renew",
        requestId: "ren-1",
        expect: "LEASE_NOT_HELD",
        writes: 0,
        restart: true,
      },
      {
        route: "release",
        requestId: "rel-1",
        expect: "LEASE_NOT_HELD",
        writes: 1,
      },
      {
        route: "release",
        requestId: "rel-1",
        expect: "LEASE_NOT_HELD",
        writes: 0,
        restart: true,
      },
    ]),
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
  "a v3 exact retry inside the 24-hour window replays and at the window end is refused as v2 refuses it",
  () =>
    scenario([
      {
        route: "claim",
        requestId: "acq-1",
        expect: 1,
        writes: 1,
        expires: E2 + HOUR,
        ttlMs: 24 * HOUR,
      },
      {
        route: "claim",
        requestId: "acq-1",
        expect: 1,
        writes: 0,
        at: E2 - 1,
        expires: E2 + HOUR,
        ttlMs: 24 * HOUR,
        restart: true,
      },
      {
        route: "claim",
        requestId: "acq-1",
        expect: "INPUT_CONFLICT",
        writes: 0,
        at: E2,
        expires: E2 + HOUR,
        ttlMs: 24 * HOUR,
      },
    ]),
  timeout,
);

test(
  "after its receipt expires, an acquisition ID with an invalid ttl is refused before the witness check and replays",
  () =>
    scenario([
      { route: "claim", requestId: "acq-1", expect: 1, writes: 1 },
      {
        route: "claim",
        requestId: "acq-1",
        expect: "INPUT_INVALID",
        writes: 1,
        at: EXPIRED,
        expires: E2,
        ttlMs: 24 * HOUR + 1,
        expired: true,
      },
      {
        route: "claim",
        requestId: "acq-1",
        expect: "INPUT_INVALID",
        writes: 0,
        at: EXPIRED,
        expires: E2,
        ttlMs: 24 * HOUR + 1,
        restart: true,
      },
    ]),
  timeout,
);

const long = "w".repeat(501);
const otherDevice = { ...holder, session: { id: "fixture", device: "other" } };
const invalidSubject = {
  code: "INPUT_INVALID",
  message: "Lease subject must be well-formed UTF-16 text",
  retry: "never",
};
const parity: readonly {
  readonly label: string;
  readonly step: Omit<Step, "requestId" | "expect" | "writes">;
  readonly expect: number | string;
  readonly writes: 0 | 1;
  readonly other?: number | string;
  readonly message?: string;
}[] = [
  {
    label: "a 501-character subject",
    step: { route: "claim", change: { subject: long } },
    expect: "INPUT_INVALID",
    writes: 1,
    other: "INPUT_INVALID",
    message: "Key must contain 1 to 500 characters",
  },
  {
    label: "a lone-surrogate subject",
    step: { route: "claim", change: { subject: "work-\ud800" } },
    expect: "INPUT_INVALID",
    writes: 1,
    other: "INPUT_INVALID",
    message: "Lease subject must be well-formed UTF-16 text",
  },
  {
    label: "a 500-character subject",
    step: { route: "claim", change: { subject: "w".repeat(500) } },
    expect: 1,
    writes: 1,
    other: "LEASE_HELD",
  },
  {
    label: "a 501-character subject",
    step: { route: "renew", change: { subject: long } },
    expect: "INPUT_INVALID",
    writes: 1,
  },
  {
    label: "a 501-character subject",
    step: { route: "release", change: { subject: long } },
    expect: "INPUT_INVALID",
    writes: 1,
  },
  {
    label: "a lone-surrogate subject",
    step: { route: "renew", change: { subject: "\ud800" } },
    expect: "INPUT_INVALID",
    writes: 1,
  },
  {
    label: "a lone-surrogate subject",
    step: { route: "release", change: { subject: "\ud800" } },
    expect: "INPUT_INVALID",
    writes: 1,
  },
  {
    label: "a 501-character subject and a zero ttl",
    step: { route: "claim", ttlMs: 0, change: { subject: long } },
    expect: "INPUT_INVALID",
    writes: 1,
    message: "ttlMs must be a positive safe integer",
  },
  {
    label: "a zero ttl",
    step: { route: "claim", ttlMs: 0 },
    expect: "INPUT_INVALID",
    writes: 1,
  },
  {
    label: "a negative ttl",
    step: { route: "renew", ttlMs: -1 },
    expect: "INPUT_INVALID",
    writes: 1,
  },
  {
    label: "a fractional ttl",
    step: { route: "claim", ttlMs: 1.5 },
    expect: "INPUT_INVALID",
    writes: 1,
  },
  {
    label: "a text ttl",
    step: { route: "claim", change: { ttlMs: "60000" } },
    expect: "INPUT_INVALID",
    writes: 1,
  },
  {
    label: "a missing ttl",
    step: { route: "claim", change: { ttlMs: undefined } },
    expect: "INPUT_INVALID",
    writes: 1,
  },
  {
    label: "a ttl over 24 hours",
    step: { route: "claim", ttlMs: 24 * HOUR + 1, expires: E2 + HOUR },
    expect: "INPUT_INVALID",
    writes: 1,
    message: "ttlMs is over 24 hours",
  },
  {
    label: "a ttl past the owner expiry",
    step: { route: "renew", ttlMs: 3 * HOUR },
    expect: "INPUT_INVALID",
    writes: 1,
    message: "ttlMs would exceed the token expiry",
  },
  {
    label: "an empty subject",
    step: { route: "claim", change: { subject: "" } },
    expect: "INPUT_INVALID",
    writes: 0,
  },
  {
    label: "a numeric subject",
    step: { route: "release", change: { subject: 7 } },
    expect: "INPUT_INVALID",
    writes: 0,
  },
  {
    label: "a missing generation",
    step: { route: "renew", change: { generation: undefined } },
    expect: "INPUT_INVALID",
    writes: 0,
  },
  {
    label: "a zero generation",
    step: { route: "release", generation: 0 },
    expect: "INPUT_INVALID",
    writes: 0,
  },
  {
    label: "a text generation",
    step: { route: "renew", change: { generation: "1" } },
    expect: "INPUT_INVALID",
    writes: 0,
  },
  {
    label: "an empty request ID",
    step: { route: "claim", change: { requestId: "" } },
    expect: "INPUT_INVALID",
    writes: 0,
  },
  {
    label: "a malformed request ID",
    step: { route: "claim", change: { requestId: "-x" } },
    expect: "INPUT_INVALID",
    writes: 0,
  },
  {
    label: "a missing holder",
    step: { route: "claim", change: { holder: undefined } },
    expect: "INPUT_INVALID",
    writes: 0,
  },
  {
    label: "another device",
    step: { route: "release", change: { holder: otherDevice } },
    expect: "AUTH_DEVICE_MISMATCH",
    writes: 0,
  },
  {
    label: "a non-object body",
    step: { route: "renew", raw: ["work-1"] },
    expect: "INPUT_INVALID",
    writes: 0,
  },
];

for (const row of parity) {
  test(
    `v3 ${row.step.route} with ${row.label} answers as v2, and its exact retry replays with zero writes`,
    async () => {
      const step = { ...row.step, requestId: "p-1", expect: row.expect };
      const v3 = await scenario([
        { ...step, writes: row.writes },
        { ...step, writes: 0, restart: true },
        ...(row.other === undefined
          ? []
          : [{ ...step, owner: "owner-b", expect: row.other, writes: 1 }]),
      ]);
      expect(v3[1]!.body).toEqual(v3[0]!.body);
      if (row.expect === "INPUT_INVALID") expect(v3[0]!.status).toBe(400);
      if (row.message !== undefined)
        expect(v3[0]!.body).toMatchObject({
          error: { message: row.message },
        });
    },
    timeout,
  );
}

for (const store of ["v2", "v3"] as const) {
  test.each(["renew", "release"] as const)(
    `${store} %s refuses an ill-formed subject that collides under SQL replacement`,
    async (route) => {
      const f = guardFixture();
      using db = f.db;
      const v3 = store === "v3";
      const malformed = "work-\ud800",
        subject = "work-\ufffd";
      const query = f.storage.sql.exec.bind(f.storage.sql);
      f.storage.sql.exec = (sql, ...bindings) => {
        const bound = bindings.map((b) => (b === malformed ? subject : b));
        return query(sql, ...bound);
      };
      if (v3) expect((await f.send(probe, {})).status).toBe(200);
      else f.restart(false);
      const send = (op: Step["route"], subject: string) =>
        f.send(
          v3 ? `${probe}/${op}` : op,
          leaseBody({ route: op, requestId: op, change: { subject } }),
          headers("owner-a", E1),
        );
      const grant = await send("claim", subject);
      expect(grant.status).toBe(200);
      const state = db.query(
        v3
          ? "SELECT json_extract(body,'$.lease') AS lease, json_extract(body,'$.events') AS events FROM cloud_v3_commits ORDER BY sequence"
          : `SELECT json_array(namespace,subject,generation,body) FROM state_leases
           UNION ALL SELECT json_array(namespace,subject,generation,body) FROM state_checkpoint_leases
           UNION ALL SELECT json_array(namespace,key,sequence,body) FROM state_events ORDER BY 1`,
      );
      const before = state.all();
      const kv = [...f.values];
      const fresh = f.observeEffects();
      setSystemTime(T0 + MINUTE);
      const refusal = await send(route, malformed);
      expect(refusal).toEqual({
        status: 400,
        body: { ok: false, error: invalidSubject },
      });
      const receipt = { lease: null, events: "[]" };
      expect(state.all()).toEqual(v3 ? [...before, receipt] : before);
      expect([...f.values]).toEqual(kv);
      const { sqlWriteAttempts, alarmWrites } = fresh();
      expect(sqlWriteAttempts).toBe(v3 ? 1 : 2);
      expect(alarmWrites).toBe(0);
      if (v3) f.restart();
      const replay = f.observeEffects();
      expect(await send(route, malformed)).toEqual(refusal);
      expect(replay()).toEqual(noWrites);
      expect(await send("claim", subject)).toEqual(grant);
    },
    timeout,
  );
}

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
  "an ownerless lease body over 8 KB gets AUTH_REQUIRED on v3 as on v2, before the body is read",
  async () => {
    const refuse = async (store: "v2" | "v3") => {
      const f = guardFixture();
      try {
        if (store === "v3") expect((await f.send(probe, {})).status).toBe(200);
        else f.restart(false);
        const effects = f.observeEffects();
        const response = await f.send(
          store === "v3" ? `${probe}/claim` : "claim",
          {
            ...leaseBody({ route: "claim", requestId: "acq-1" }),
            pad: "x".repeat(9000),
          },
        );
        return { ...response, ...effects() };
      } finally {
        f.db.close();
      }
    };
    const v2 = await refuse("v2");
    expect(v2).toMatchObject({
      status: 401,
      body: { ok: false, error: { code: "AUTH_REQUIRED" } },
      ...noWrites,
    });
    expect(await refuse("v3")).toEqual(v2);
  },
  timeout,
);

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
