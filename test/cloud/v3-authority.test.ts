import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import {
  authorityFault,
  isDigest,
  isNat,
} from "../../cloud/src/v3-authority.ts";
import { digestBytes } from "../../src/core/config/pointer.ts";
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

const at = (path: string, value: unknown) => (frame: Json) => {
  const copy = structuredClone(frame);
  const keys = path.split(".");
  const last = keys.pop()!;
  const target = keys.reduce<Json>((node, key) => node[key] as Json, copy);
  if (value === undefined) delete target[last];
  else target[last] = value;
  return copy;
};

const claimed: readonly [string, (frame: Json) => Json][] = [
  ["an empty lease", at("lease", {})],
  ["a null lease", at("lease", null)],
  ["a false lease", at("lease", false)],
  ["a zero lease", at("lease", 0)],
  ["an empty-string lease", at("lease", "")],
  ["a lease with an extra key", at("lease.extra", 1)],
  ["a lease with a number subject", at("lease.subject", 7)],
  ["a lease with a fractional generation", at("lease.generation", 1.5)],
  ["an empty outcome", at("outcome", {})],
  ["a null outcome", at("outcome", null)],
  ["an outcome missing its fingerprint", at("outcome.fingerprint", undefined)],
  ["an outcome with an extra key", at("outcome.extra", 1)],
  ["an outcome with a number id", at("outcome.id", 7)],
  ["an outcome with an empty id", at("outcome.id", "")],
  ["an outcome with a number fingerprint", at("outcome.fingerprint", 7)],
  ["an outcome with a negative deadline", at("outcome.retryUntil", -1)],
  ["an outcome with another family", at("outcome.scope.family", "command")],
  ["an outcome scope with an extra key", at("outcome.scope.extra", 1)],
  ["an outcome scope of another version", at("outcome.scope.version", 1)],
  [
    "an outcome scope whose principal is not a digest",
    at("outcome.scope.principal", "owner-a"),
  ],
  ["an ok outcome carrying a result", at("outcome.result", { code: "ok" })],
  ["an outcome with another status", at("outcome.status", "LEASE_HELD")],
  ["an ok outcome without its lease", at("lease", undefined)],
  ["a lease without an outcome", at("outcome", undefined)],
  ["an empty witness", at("witness", {})],
  ["a null witness", at("witness", null)],
  ["a witness with an extra key", at("witness.extra", 1)],
  ["a witness in another namespace", at("witness.namespace", "forge/other")],
  ["a witness for another request", at("witness.id", "acq-9")],
  ["a witness for another subject", at("witness.subject", "work-2")],
  ["a witness at another generation", at("witness.generation", 2)],
  ["a witness whose digest is not a digest", at("witness.digest", "abc")],
];

const refused: readonly [string, (frame: Json) => Json][] = [
  ["a refusal whose status is not its code", at("outcome.status", "ok")],
  ["a refusal with an invalid result", at("outcome.result", { code: 7 })],
  [
    "a refusal carrying a lease",
    (frame) => ({ ...frame, lease: { subject: "work-1" } }),
  ],
  [
    "a refusal carrying a witness without a lease",
    (frame) => ({
      ...frame,
      witness: {
        namespace: "forge/work",
        id: "acq-2",
        subject: "work-1",
        generation: 1,
        digest: digestBytes("x"),
      },
    }),
  ],
];

test(
  "the shared validator refuses every malformed lease, outcome and witness after-image",
  async () => {
    const [claim, refusal] = await writerFrames();
    const faults = [
      ...claimed.map(([label, edit]) => [label, authorityFault(edit(claim!))]),
      ...refused.map(([label, edit]) => [
        label,
        authorityFault(edit(refusal!)),
      ]),
    ];
    expect(faults.filter(([, fault]) => fault === undefined)).toEqual([]);
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
