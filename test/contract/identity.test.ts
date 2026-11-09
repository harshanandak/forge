import { expect, test } from "bun:test";
import type { ClockPort } from "../../src/ports/clock.ts";
import type {
  IdentityVerifier,
  VerifiedIdentity,
} from "../../src/ports/identity.ts";
import { testIdentityVerifier } from "./lib/identity-verifier.ts";

const identity: VerifiedIdentity = {
  issuer: "https://first.example",
  subject: "Person-A",
  audience: "forge",
  expiresAt: 2_000,
  authenticatedAt: 500,
};
const clock: ClockPort = { now: () => 1_000 };

function verifier(overrides: Partial<VerifiedIdentity> = {}): IdentityVerifier {
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
  expect(firstResult).toEqual({ ok: true, identity });
  expect(secondResult).toEqual({ ok: true, identity: second });
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
    expect(await verifier(exact).verify("known", "forge", clock.now())).toEqual(
      {
        ok: true,
        identity: { ...identity, ...exact },
      },
    );
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
    expect(await verifier().verify("known", "forge", at.now())).toEqual(
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
