import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import type { LeaseCommand } from "../../cloud/src/lease-command.ts";
import { writableStore } from "../../cloud/src/store.ts";
import {
  authorityFault,
  isDigest,
  isNat,
} from "../../cloud/src/v3-authority.ts";
import { leaseV3, recoverV3 } from "../../cloud/src/v3-store.ts";
import { ForgeFailure } from "../../src/contract/failure.ts";
import { canonicalJson, digestBytes } from "../../src/core/config/pointer.ts";
import { validateForgeError } from "../../src/generated/validators.ts";
import { fixture, probe } from "./v3-project.fixture.ts";

const timeout = 30_000;
const HOUR = 3_600_000;
const T0 = Date.parse("2026-11-20T12:00:00.000Z");
const E1 = T0 + 2 * HOUR;
const holder = {
  actor: { kind: "agent", id: "fixture" },
  session: { id: "fixture" },
};

type Json = Record<string, unknown>;

beforeEach(() => setSystemTime(T0));
afterEach(() => setSystemTime());

async function writerFrames(): Promise<Json[]> {
  const f = fixture();
  try {
    const send = (route: string, owner: string, body: Json) =>
      f.send(
        `${probe}/${route}`,
        { subject: "work-1", holder, ...body },
        { "X-Forge-Owner": owner, "X-Forge-Owner-Expires": String(E1) },
      );
    expect((await f.send(probe, {})).status).toBe(200);
    const steps = [
      ["claim", "owner-a", { requestId: "acq-1", ttlMs: HOUR }, 200],
      ["claim", "owner-b", { requestId: "acq-2", ttlMs: HOUR }, 409],
      [
        "renew",
        "owner-a",
        { requestId: "ren-1", generation: 1, ttlMs: HOUR },
        200,
      ],
      ["release", "owner-a", { requestId: "rel-1", generation: 1 }, 200],
    ] as const;
    for (const [route, owner, body, status] of steps)
      expect((await send(route, owner, body)).status).toBe(status);
    return f.db
      .query<{ body: string }, []>(
        "SELECT body FROM cloud_v3_commits ORDER BY sequence",
      )
      .all()
      .map(({ body }) => JSON.parse(body) as Json);
  } finally {
    f.db.close();
  }
}

test(
  "every after-image leaseV3 writes passes the shared validator",
  async () => {
    const frames = await writerFrames();
    expect(frames.map((frame) => frame.operation)).toEqual([
      "lease.claim",
      "lease.claim",
      "lease.renew",
      "lease.release",
    ]);
    expect(frames[0]).toHaveProperty("witness");
    expect(frames[1]).not.toHaveProperty("lease");
    for (const frame of frames) expect(authorityFault(frame)).toBeUndefined();
    expect(
      authorityFault({ operation: "fixture.put", time: T0, events: [] }),
    ).toBeUndefined();
  },
  timeout,
);

test(
  "a malformed stored lease is refused by recovery on the route, and a refusal leaseV3 builds from it is never appended",
  async () => {
    const f = fixture();
    try {
      const send = (owner: string, subject: string, requestId: string) =>
        f.send(
          `${probe}/claim`,
          { subject, holder, requestId, ttlMs: HOUR },
          { "X-Forge-Owner": owner, "X-Forge-Owner-Expires": String(E1) },
        );
      expect((await f.send(probe, {})).status).toBe(200);
      expect((await send("owner-a", "work-1", "acq-1")).status).toBe(200);
      const db = writableStore(f.storage);
      const image = recoverV3(db);
      expect(
        f.db.run(
          "UPDATE cloud_v3_commits SET body=json_set(body,'$.lease.generation',0) WHERE sequence=1",
        ).changes,
      ).toBe(1);
      f.restart();
      const rows = () =>
        f.db
          .query<{ sequence: number; body: string }, []>(
            "SELECT sequence, body FROM cloud_v3_commits ORDER BY sequence",
          )
          .all();
      const stored = rows();
      const before = f.snapshot();
      expect(await send("owner-b", "work-1", "acq-2")).toMatchObject({
        status: 503,
        body: { ok: false, error: { code: "UNAVAILABLE" } },
      });
      const command = (subject: string, requestId: string) =>
        ({
          route: "claim",
          subject,
          holder,
          ttlMs: HOUR,
          generation: null,
          rawId: requestId,
          requestId,
          scope: { principal: digestBytes("owner-b"), version: 2 },
        }) as LeaseCommand;
      let thrown: unknown;
      try {
        leaseV3(db, image, command("work-1", "acq-2"), E1);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(ForgeFailure);
      expect((thrown as Error).message).toBe(
        "Refusing a v3 frame with an invalid outcome status",
      );
      expect(rows()).toEqual(stored);
      expect(f.snapshot()).toEqual(before);
      expect(leaseV3(db, image, command("work-2", "acq-3"), E1)).toMatchObject({
        subject: "work-2",
        generation: 1,
      });
    } finally {
      f.db.close();
    }
  },
  timeout,
);

const DELETE = Symbol("delete");
const at = (path: string, value: unknown) => (frame: Json) => {
  const copy = structuredClone(frame);
  const keys = path.split(".");
  const last = keys.pop()!;
  const target = keys.reduce<Json>((node, key) => node[key] as Json, copy);
  if (value === DELETE) delete target[last];
  else target[last] = value;
  return copy;
};
const stored = (frame: Json) => JSON.parse(canonicalJson(frame)) as Json;
const RELEASED = "2026-11-20T12:30:00.000Z";
const UNAVAILABLE = {
  code: "UNAVAILABLE",
  message: "Cloud v3 root is unavailable",
  retry: "never",
};

test(
  "the shared validator refuses every malformed lease, outcome and witness after-image with its reason",
  async () => {
    const [claim, refusal, renew, release] = (await writerFrames()) as [
      Json,
      Json,
      Json,
      Json,
    ];
    expect(validateForgeError(UNAVAILABLE).ok).toBe(true);
    const cases: readonly [string, Json, string][] = [
      ["an empty lease", at("lease", {})(claim), "lease"],
      ["a null lease", at("lease", null)(claim), "lease"],
      ["a false lease", at("lease", false)(claim), "lease"],
      ["a zero lease", at("lease", 0)(claim), "lease"],
      ["an empty-string lease", at("lease", "")(claim), "lease"],
      ["a lease with an extra key", at("lease.extra", 1)(claim), "lease"],
      ["a lease with a number subject", at("lease.subject", 7)(claim), "lease"],
      [
        "a lease with a fractional generation",
        at("lease.generation", 1.5)(claim),
        "lease",
      ],
      [
        "a claimed lease marked released",
        at("lease.releasedAt", RELEASED)(claim),
        "lease release marker",
      ],
      [
        "a renewed lease marked released",
        at("lease.releasedAt", RELEASED)(renew),
        "lease release marker",
      ],
      [
        "a released lease without its marker",
        at("lease.releasedAt", DELETE)(release),
        "lease release marker",
      ],
      ["an empty outcome", at("outcome", {})(claim), "outcome shape"],
      ["a null outcome", at("outcome", null)(claim), "outcome shape"],
      [
        "an outcome missing its fingerprint",
        at("outcome.fingerprint", DELETE)(claim),
        "outcome fields",
      ],
      [
        "an outcome with an extra key",
        at("outcome.extra", 1)(claim),
        "outcome fields",
      ],
      [
        "an outcome with a number id",
        at("outcome.id", 7)(claim),
        "outcome fields",
      ],
      [
        "an outcome with an empty id",
        at("outcome.id", "")(claim),
        "outcome fields",
      ],
      [
        "an outcome with a number fingerprint",
        at("outcome.fingerprint", 7)(claim),
        "outcome fields",
      ],
      [
        "an outcome with an empty fingerprint",
        at("outcome.fingerprint", "")(claim),
        "outcome fields",
      ],
      [
        "an outcome with a negative deadline",
        at("outcome.retryUntil", -1)(claim),
        "outcome fields",
      ],
      [
        "an outcome with another family",
        at("outcome.scope.family", "command")(claim),
        "outcome scope",
      ],
      [
        "an outcome scope with an extra key",
        at("outcome.scope.extra", 1)(claim),
        "outcome scope",
      ],
      [
        "an outcome scope of another version",
        at("outcome.scope.version", 1)(claim),
        "outcome scope",
      ],
      [
        "an outcome scope whose principal is not a digest",
        at("outcome.scope.principal", "owner-a")(claim),
        "outcome scope",
      ],
      [
        "an ok outcome carrying a result",
        at("outcome.result", { code: "ok" })(claim),
        "outcome status",
      ],
      [
        "an outcome with another status",
        at("outcome.status", "LEASE_HELD")(claim),
        "outcome status",
      ],
      [
        "a refusal whose status is not its code",
        at("outcome.status", "ok")(refusal),
        "outcome status",
      ],
      [
        "a refusal with an invalid result",
        at("outcome.result", { code: 7 })(refusal),
        "outcome status",
      ],
      [
        "a refusal with an undefined status and an invalid result",
        at("outcome.result", { code: 7 })(
          at("outcome.status", undefined)(refusal),
        ),
        "outcome status",
      ],
      [
        "a refusal with a code leaseV3 never records",
        at(
          "outcome.status",
          "UNAVAILABLE",
        )(at("outcome.result", UNAVAILABLE)(refusal)),
        "outcome status",
      ],
      [
        "an ok outcome without its lease",
        at("lease", DELETE)(claim),
        "lease and ok outcome pairing",
      ],
      [
        "a lease without an outcome on a non-lease operation",
        at("operation", "fixture.put")(at("outcome", DELETE)(claim)),
        "lease and ok outcome pairing",
      ],
      [
        "a claim without its outcome",
        at("outcome", DELETE)(claim),
        "outcome operation",
      ],
      [
        "a refused claim without its outcome",
        at("outcome", DELETE)(refusal),
        "outcome operation",
      ],
      [
        "a claim refused with a renew or release code",
        at(
          "outcome.status",
          "LEASE_STALE",
        )(
          at("outcome.result", {
            ...((refusal.outcome as Json).result as Json),
            code: "LEASE_STALE",
          })(refusal),
        ),
        "outcome route",
      ],
      [
        "a renew refused with the claim code",
        at("outcome", {
          ...(renew.outcome as Json),
          status: "LEASE_HELD",
          result: (refusal.outcome as Json).result,
        })(at("lease", DELETE)(renew)),
        "outcome route",
      ],
      [
        "a refusal carrying a lease its fingerprint names",
        at("lease", {
          ...(claim.lease as Json),
          holder: (
            JSON.parse(String((refusal.outcome as Json).fingerprint)) as Json
          ).holder,
        })(refusal),
        "lease and ok outcome pairing",
      ],
      [
        "a refusal whose own undefined lease is stored",
        stored(at("lease", undefined)(refusal)),
        "lease",
      ],
      ["a claim without its witness", at("witness", DELETE)(claim), "witness"],
      [
        "a claim whose own undefined witness is stored",
        stored(at("witness", undefined)(claim)),
        "witness",
      ],
      ["a witness on a renew", at("witness", claim.witness)(renew), "witness"],
      [
        "a witness on a release",
        at("witness", claim.witness)(release),
        "witness",
      ],
      [
        "a witness on a refusal",
        at("witness", claim.witness)(refusal),
        "witness",
      ],
      ["an empty witness", at("witness", {})(claim), "witness"],
      ["a null witness", at("witness", null)(claim), "witness"],
      ["a witness with an extra key", at("witness.extra", 1)(claim), "witness"],
      [
        "a witness in another namespace",
        at("witness.namespace", "forge/other")(claim),
        "witness",
      ],
      [
        "a witness for another request",
        at("witness.id", "acq-9")(claim),
        "witness",
      ],
      [
        "a witness for another subject",
        at("witness.subject", "work-2")(claim),
        "witness",
      ],
      [
        "a witness at another generation",
        at("witness.generation", 2)(claim),
        "witness",
      ],
      [
        "a witness whose digest is not a digest",
        at("witness.digest", "abc")(claim),
        "witness",
      ],
      [
        "a witness whose digest is not its fingerprint's",
        at("witness.digest", digestBytes("x"))(claim),
        "witness",
      ],
      [
        "an ok outcome on an operation leaseV3 never writes",
        at("operation", "fixture.put")(claim),
        "outcome operation",
      ],
      [
        "a refusal on an operation leaseV3 never writes",
        at("operation", "fixture.put")(refusal),
        "outcome operation",
      ],
      [
        "a refusal with a lease code leaseV3 never records",
        at(
          "outcome.status",
          "LEASE_FOO",
        )(
          at("outcome.result", {
            ...((refusal.outcome as Json).result as Json),
            code: "LEASE_FOO",
          })(refusal),
        ),
        "outcome status",
      ],
      [
        "a renew recorded as a claim",
        at("operation", "lease.claim")(renew),
        "outcome fingerprint",
      ],
      [
        "a refusal recorded on another route",
        at("operation", "lease.renew")(refusal),
        "outcome fingerprint",
      ],
      [
        "a lease for another subject than its fingerprint",
        at("lease.subject", "work-2")(renew),
        "outcome fingerprint",
      ],
      [
        "a lease for another holder than its fingerprint",
        at("lease.holder", { ...holder, actor: { kind: "agent", id: "x" } })(
          renew,
        ),
        "outcome fingerprint",
      ],
      [
        "a lease at another generation than its fingerprint",
        at("lease.generation", 2)(release),
        "outcome fingerprint",
      ],
      [
        "an outcome scope for another principal than its fingerprint",
        at("outcome.scope.principal", digestBytes("x"))(renew),
        "outcome fingerprint",
      ],
      [
        "a fingerprint that is not JSON",
        at("outcome.fingerprint", "x")(renew),
        "outcome fingerprint",
      ],
      [
        "a fingerprint that is not canonical",
        at(
          "outcome.fingerprint",
          ` ${String((renew.outcome as Json).fingerprint)}`,
        )(renew),
        "outcome fingerprint",
      ],
    ];
    expect(
      cases.map(([label, frame]) => [label, authorityFault(frame)]),
    ).toEqual(cases.map(([label, , reason]) => [label, reason]));
  },
  timeout,
);

test(
  "the digest and natural number checks accept only their exact forms",
  () => {
    expect(isDigest(digestBytes("x"))).toBe(true);
    for (const value of [
      digestBytes("x").toUpperCase(),
      `${digestBytes("x")}0`,
      "sha256:abc",
      7,
      null,
    ])
      expect(isDigest(value)).toBe(false);
    for (const value of [0, 1, Number.MAX_SAFE_INTEGER])
      expect(isNat(value)).toBe(true);
    for (const value of [-1, 1.5, Number.NaN, "1", null, 2 ** 53])
      expect(isNat(value)).toBe(false);
  },
  timeout,
);
