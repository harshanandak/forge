import { timingSafeEqual } from "node:crypto";
import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { writableStore } from "../../cloud/src/store.ts";
import { claimEffect, recoverV3 } from "../../cloud/src/v3-store.ts";
import { guardFixture, probe } from "./v3-project.fixture.ts";

if (!("timingSafeEqual" in crypto.subtle))
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    value: timingSafeEqual,
  });

const timeout = 30_000;
const time = Date.parse("2026-11-20T12:00:00.000Z");
const ttlMs = 3_600_000;
const env = { FORGE_CLOUD_PROJECT: "a", FORGE_CLOUD_ID_PREFIX: "forge" };
const actor = { kind: "agent", id: "fixture" } as const;
const holder = { actor, session: { id: "fixture", device: "laptop" } };
const tablet = { actor, session: { id: "fixture", device: "tablet" } };
const subject = "issue:work-1";
const expiresAt = new Date(time + ttlMs).toISOString();
const member = { subject, holder, generation: 1, expiresAt };
const held = `${subject} is leased by device laptop, agent fixture, harness unspecified, session fixture until ${expiresAt}`;

type Verdict = { refusal: object; recorded: boolean };
interface Refusals {
  updateDecision(image: unknown, basis: object, time: number): unknown;
  claimDecision(
    image: unknown,
    basis: object,
    time: number,
    retryUntil: number,
    witnessed: boolean,
    effect: typeof claimEffect,
  ): unknown;
  basisFault(operation: string, basis: unknown): string | undefined;
  INPUT_REFUSALS: Record<string, unknown>;
}
const path = "../../cloud/src/v3-refusals.ts";
const load = () => import(path) as Promise<Refusals>;

beforeEach(() => setSystemTime(time));
afterEach(() => setSystemTime());

const never = (code: string, message: string) => ({
  code,
  message,
  retry: "never",
});
const refusal = (error: object, recorded = true): Verdict => ({
  refusal: error,
  recorded,
});
const leased = (code: string, message: string, lease: object = member) =>
  refusal({ code, message, retry: "reconcile_first", lease });

const issue = (number: number, extra: object = {}) => ({
  id: `work-${number}`,
  prefix: "forge",
  title: "Before",
  status: "open",
  labels: [],
  dependsOn: [],
  createdAt: new Date(time).toISOString(),
  ...extra,
});

async function state() {
  const f = guardFixture(env);
  expect(await f.send(probe, {})).toMatchObject({ status: 200 });
  const issues = [
    issue(1),
    issue(2, { status: "closed" }),
    issue(3, { dependsOn: ["work-1", "work-9"] }),
    issue(4),
  ];
  const frames = issues.map((value) => {
    const key = `r${value.id.slice(5)}`;
    return {
      operation: "fixture.put",
      time,
      events: [{ key, revision: 1, value }],
      changes: [{ key, value: { revision: 1, value } }],
    };
  });
  expect(await f.send(`${probe}/commits`, { frames })).toMatchObject({
    status: 200,
  });
  const owner = {
    "X-Forge-Owner": "laptop",
    "X-Forge-Owner-Expires": String(time + 2 * ttlMs),
  };
  expect(
    await f.send(
      `${probe}/claim`,
      {
        requestId: "raw-claim",
        subject,
        holder: { actor, session: { id: "fixture" } },
        ttlMs,
      },
      owner,
    ),
  ).toMatchObject({ status: 200 });
  const db = writableStore(f.storage);
  return { f, image: () => recoverV3(db, f.seal()) };
}

const upd = {
  stage: "state",
  id: "forge-1",
  prefix: "forge",
  expectRevision: 1,
  holder,
  generation: 1,
};
const clm = {
  stage: "state",
  id: "forge-1",
  prefix: "forge",
  holder,
  ttlMs: 1000,
};

test(
  "v3 updateDecision returns the writer's exact refusal or the values updateEffect needs",
  async () => {
    const m = await load();
    const { f, image } = await state();
    using _db = f.db;
    const basis = (id: string, change: object = {}) => ({
      ...upd,
      id,
      ...change,
    });
    const decide = (b: object, at = time) => m.updateDecision(image(), b, at);
    const notHeld = `${held}; this caller does not hold that lease`;
    expect(decide(basis("other-1"))).toEqual(
      refusal(never("INPUT_INVALID", "Unknown issue id prefix")),
    );
    expect(decide(basis("forge-9"))).toEqual(
      refusal(never("NOT_FOUND", "Issue was not found")),
    );
    expect(decide(basis("forge-4"))).toEqual(
      leased("LEASE_NOT_HELD", "issue:work-4 has no lease", {
        subject: "issue:work-4",
      }),
    );
    expect(decide(basis("forge-1", { holder: tablet }))).toEqual(
      leased("LEASE_NOT_HELD", notHeld),
    );
    expect(decide(basis("forge-1", { generation: 2 }))).toEqual(
      leased(
        "LEASE_STALE",
        `generation 2 is not the current generation 1 of ${subject}`,
      ),
    );
    expect(decide(basis("forge-1"), time + ttlMs)).toEqual(
      leased(
        "LEASE_EXPIRED",
        `the lease on ${subject} expired at ${expiresAt}; a lapsed lease is reacquired, never renewed`,
      ),
    );
    expect(decide(basis("forge-1", { expectRevision: 2 }))).toEqual(
      refusal({
        code: "REVISION_CONFLICT",
        message: "Expected revision 2; current revision is 1",
        retry: "reconcile_first",
        currentRevision: 1,
      }),
    );
    const at = image();
    expect(m.updateDecision(at, basis("forge-1"), time)).toEqual({
      key: "r1",
      current: at.load("record", "r1"),
      lease: at.load("lease", subject),
    });
  },
  timeout,
);

test(
  "v3 claimDecision returns the writer's exact refusal, the unrecorded witness step or the claimEffect result",
  async () => {
    const m = await load();
    const { f, image } = await state();
    using _db = f.db;
    const retryUntil = time + 2 * ttlMs;
    const basis = (id: string, ttl = 60_000) => ({
      ...clm,
      id,
      holder: tablet,
      ttlMs: ttl,
    });
    const decide = (b: object, witnessed = false) =>
      m.claimDecision(image(), b, time, retryUntil, witnessed, claimEffect);
    const prefix = never("INPUT_INVALID", "Unknown issue id prefix");
    expect(decide(basis("other-1"), true)).toEqual(refusal(prefix));
    expect(decide(basis("forge-4"), true)).toEqual(
      refusal(never("LEASE_STALE", "The claim receipt expired"), false),
    );
    expect(decide(basis("forge-9"))).toEqual(
      refusal(never("NOT_FOUND", "Issue forge-9 was not found")),
    );
    expect(decide(basis("forge-2"))).toEqual(
      refusal(never("INPUT_CONFLICT", "Closed issues cannot be claimed")),
    );
    expect(decide(basis("forge-3"))).toEqual(
      refusal({
        code: "CLAIM_BLOCKED",
        message:
          'forge-1 (open) {"actor":{"id":"fixture","kind":"agent"},"session":{"device":"laptop","id":"fixture"}}, forge-9 (missing) ',
        retry: "never",
        observed: {
          blockers: [
            { id: "forge-1", holder, holderUnverified: true },
            { id: "forge-9" },
          ],
        },
      }),
    );
    expect(decide(basis("forge-4", 86_401_000))).toEqual(
      refusal(never("INPUT_INVALID", "ttlMs is over 24 hours")),
    );
    expect(decide(basis("forge-4", 7_201_000))).toEqual(
      refusal(never("INPUT_INVALID", "ttlMs would exceed the token expiry")),
    );
    expect(decide(basis("forge-1"))).toEqual(
      leased(
        "LEASE_HELD",
        `${held}; read its state to reconcile instead of retrying`,
      ),
    );
    const claim = {
      subject: "issue:work-4",
      prefix: "forge",
      holder: tablet,
      ttlMs: 60_000,
    };
    expect(decide(basis("forge-4"))).toEqual({
      effect: claimEffect(image(), claim, time, retryUntil),
    });
  },
  timeout,
);

test(
  "v3 INPUT_REFUSALS holds exactly the fixed input errors of each operation",
  async () => {
    const m = await load();
    const list = (...messages: string[]) =>
      messages.map((message) => never("INPUT_INVALID", message));
    expect(m.INPUT_REFUSALS).toEqual({
      "issue.create": list(
        "Parent and dependencies are not supported in cloud yet",
        "input must be a valid issue.create input",
        "kind must be one of task, bug, feature, epic",
      ),
      "issue.update": list(
        "Kind, parent and dependencies are not supported in cloud yet",
        "input must be a valid issue.update input",
        "Invalid issue id",
      ),
      "issue.claim": list("Expected a valid issue claim", "Invalid issue id"),
    });
    expect(JSON.stringify(m.INPUT_REFUSALS)).not.toContain("Unknown issue id");
  },
  timeout,
);

test(
  "v3 basisFault accepts every valid basis",
  async () => {
    const m = await load();
    const max = 9_007_199_254_740_992;
    for (const op of ["issue.create", "issue.update", "issue.claim"])
      expect(m.basisFault(op, { stage: "input" })).toBeUndefined();
    const ids = { id: `${"a".repeat(197)}-12` };
    const shapes = [
      {},
      { prefix: "0" },
      { prefix: "a".repeat(32) },
      ids,
      { id: "Forge-1" },
    ];
    for (const change of shapes) {
      expect(
        m.basisFault("issue.update", { ...upd, ...change }),
      ).toBeUndefined();
      expect(
        m.basisFault("issue.claim", { ...clm, ...change }),
      ).toBeUndefined();
    }
    for (const change of [
      { expectRevision: max },
      { generation: max },
      { expectRevision: max, generation: max },
    ])
      expect(
        m.basisFault("issue.update", { ...upd, ...change }),
      ).toBeUndefined();
    for (const ttl of [1000, 604_800_000])
      expect(
        m.basisFault("issue.claim", { ...clm, ttlMs: ttl }),
      ).toBeUndefined();
  },
  timeout,
);

test(
  "v3 basisFault refuses every malformed basis",
  async () => {
    const m = await load();
    const without = (base: object, key: string) =>
      Object.fromEntries(Object.entries(base).filter(([name]) => name !== key));
    const shared = (base: object) => [
      ...Object.keys(base).map((key) => without(base, key)),
      { ...base, extra: 1 },
      { ...base, id: 1 },
      { ...base, id: "bad" },
      { ...base, id: `${"a".repeat(198)}-12` },
      { ...base, holder: "x" },
      { ...base, holder: { actor } },
      { ...base, holder: { ...holder, pad: "x".repeat(9000) } },
      ...["", "a".repeat(33), "Forge", "-a", "a-", "a--b"].map((prefix) => ({
        ...base,
        prefix,
      })),
    ];
    const counters = ["expectRevision", "generation"].flatMap((key) =>
      [0, -1, 1.5, NaN, Infinity, "1"].map((value) => ({
        ...upd,
        [key]: value,
      })),
    );
    const ttls = [1500, 0, -1000, 604_801_000, NaN, "1000"].map((ttl) => ({
      ...clm,
      ttlMs: ttl,
    }));
    const refused: [string, unknown][] = [
      ["issue.nope", { stage: "input" }],
      ["issue.update", { stage: "other" }],
      ["issue.update", { stage: "input", id: "forge-1" }],
      ["issue.claim", { stage: "state" }],
      ["issue.update", null],
      ["issue.claim", "state"],
      ["issue.create", upd],
      ["issue.create", clm],
      ["issue.update", clm],
      ["issue.claim", upd],
      ...[...shared(upd), ...counters].map((b): [string, unknown] => [
        "issue.update",
        b,
      ]),
      ...[...shared(clm), ...ttls].map((b): [string, unknown] => [
        "issue.claim",
        b,
      ]),
    ];
    for (const [op, basis] of refused)
      expect(typeof m.basisFault(op, basis)).toBe("string");
  },
  timeout,
);
