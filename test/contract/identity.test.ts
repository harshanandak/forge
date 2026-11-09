import { expect, test } from "bun:test";
import type { ClockPort } from "../../src/ports/clock.ts";
import {
  isVerifiedIdentity,
  type VerifiedIdentity,
  type IdentityVerifier,
  type IdentityClaims,
} from "../../src/ports/identity.ts";
import { testIdentityVerifier } from "./lib/identity-verifier.ts";

const identity: IdentityClaims = {
  issuer: "https://first.example",
  subject: "Person-A",
  audience: "forge",
  expiresAt: 2_000,
  authenticatedAt: 500,
};
const clock: ClockPort = { now: () => 1_000 };

function verifier(overrides: Partial<IdentityClaims> = {}): IdentityVerifier {
  return testIdentityVerifier(
    new Map([["known", { ...identity, ...overrides }]]),
  );
}

test("verified identities retain exact issuer and subject pairs", async () => {
  const second = { ...identity, issuer: "https://second.example" };
  const verify = testIdentityVerifier(
    new Map([
      ["first", identity],
      ["second", second],
    ]),
  );
  const firstResult = await verify.verify("first", "forge", clock.now());
  const secondResult = await verify.verify("second", "forge", clock.now());
  expect<unknown>(firstResult).toEqual({ ok: true, identity });
  expect<unknown>(secondResult).toEqual({ ok: true, identity: second });
  if (!firstResult.ok || !secondResult.ok)
    throw new Error("Expected verified identities");
  expect([
    firstResult.identity.issuer,
    firstResult.identity.subject,
  ]).not.toEqual([secondResult.identity.issuer, secondResult.identity.subject]);
  for (const exact of [
    { issuer: "https://FIRST.example/" },
    { subject: "person-a" },
    { subject: " Person-A " },
  ]) {
    expect<unknown>(
      await verifier(exact).verify("known", "forge", clock.now()),
    ).toEqual({
      ok: true,
      identity: { ...identity, ...exact },
    });
  }
}, 1_000);

test("empty issuer or subject is refused", async () => {
  for (const [field, reason] of [
    ["issuer", "empty_issuer"],
    ["subject", "empty_subject"],
  ] as const) {
    expect(
      await verifier({ [field]: "" }).verify("known", "forge", clock.now()),
    ).toEqual({
      ok: false,
      reason,
    });
  }
}, 1_000);

test("proof audience must equal the expected audience", async () => {
  expect(
    await verifier().verify("known", "another-resource", clock.now()),
  ).toEqual({
    ok: false,
    reason: "wrong_audience",
  });
}, 1_000);

test("expiry refuses at the exact boundary using injected time", async () => {
  for (const now of [1_999, 2_000, 2_001]) {
    const at: ClockPort = { now: () => now };
    expect<unknown>(
      await verifier().verify("known", "forge", at.now()),
    ).toEqual(
      now < identity.expiresAt
        ? { ok: true, identity }
        : { ok: false, reason: "expired" },
    );
  }
}, 1_000);

test("unknown or malformed proofs never become principals", async () => {
  for (const proof of [
    "unknown",
    "",
    null,
    undefined,
    42,
    [],
    {},
    identity,
    { proof: "known" },
  ]) {
    expect(await verifier().verify(proof, "forge", clock.now())).toEqual({
      ok: false,
      reason: "invalid_proof",
    });
  }
}, 1_000);

async function verified(): Promise<VerifiedIdentity> {
  const result = await verifier().verify("known", "forge", clock.now());
  if (!result.ok) throw new Error("Expected verified identity");
  return result.identity;
}

test("verifier output carries runtime provenance", async () => {
  expect(isVerifiedIdentity(await verified())).toBe(true);
}, 1_000);

for (const [name, copy] of [
  [
    "changed spread",
    (real: VerifiedIdentity) => ({ ...real, subject: "victim" }),
  ],
  ["unchanged spread", (real: VerifiedIdentity) => ({ ...real })],
  [
    "JSON round-trip",
    (real: VerifiedIdentity) => JSON.parse(JSON.stringify(real)) as unknown,
  ],
  ["structured clone", (real: VerifiedIdentity) => structuredClone(real)],
  ["cast literal", () => ({ ...identity }) as VerifiedIdentity],
] as const) {
  test(`${name} loses verified provenance`, async () => {
    const real = await verified();
    expect(isVerifiedIdentity(real)).toBe(true);
    expect(isVerifiedIdentity(copy(real))).toBe(false);
    expect(isVerifiedIdentity(real)).toBe(true);
  }, 1_000);
}

test("verified identities stay frozen with their original subject", async () => {
  const real = await verified();
  expect(Object.isFrozen(real)).toBe(true);
  try {
    (real as { subject: string }).subject = "victim";
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
  }
  expect(real.subject).toBe(identity.subject);
  expect(isVerifiedIdentity(real)).toBe(true);
}, 1_000);

test("unverified primitives and claims have no provenance", () => {
  for (const value of [null, undefined, true, 42, "known", [], {}, identity])
    expect(isVerifiedIdentity(value)).toBe(false);
}, 1_000);

for (const [name, record] of [
  ["null", null],
  ["array", []],
  ["missing issuer", { subject: identity.subject }],
  ["numeric issuer", { ...identity, issuer: 42 }],
  ["missing subject", { ...identity, subject: undefined }],
  ["numeric subject", { ...identity, subject: 42 }],
  ["numeric audience", { ...identity, audience: 42 }],
  ["missing expiry", { ...identity, expiresAt: undefined }],
  ["infinite expiry", { ...identity, expiresAt: Infinity }],
  ["invalid authentication time", { ...identity, authenticatedAt: NaN }],
  ["extra field", { ...identity, role: "admin" }],
] as const) {
  test(`malformed resolved record refuses ${name}`, async () => {
    const verify = testIdentityVerifier(
      new Map([["known", record as unknown as IdentityClaims]]),
    );
    expect(await verify.verify("known", "forge", clock.now())).toEqual({
      ok: false,
      reason: "invalid_proof",
    });
  }, 1_000);
}
