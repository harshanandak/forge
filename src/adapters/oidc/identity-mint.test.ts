import { expect, test } from "bun:test";
import { mintIdentity, isVerifiedIdentity } from "../../ports/identity-mint.ts";
import type { IdentityClaims } from "../../ports/identity.ts";

test("minting refuses malformed claims without registering them", () => {
  const valid: IdentityClaims = {
    issuer: "https://issuer.example",
    subject: "person",
    audience: "forge",
    expiresAt: 2_000,
    authenticatedAt: 500,
  };
  for (const value of [
    null,
    undefined,
    {},
    [],
    { ...valid, issuer: "" },
    { ...valid, issuer: 42 },
    { ...valid, subject: "" },
    { ...valid, subject: 42 },
    { ...valid, audience: 42 },
    { ...valid, expiresAt: "2000" },
    { ...valid, expiresAt: Infinity },
    { ...valid, authenticatedAt: NaN },
  ]) {
    expect(() => mintIdentity(value as IdentityClaims)).toThrow(TypeError);
    expect(isVerifiedIdentity(value)).toBe(false);
  }
}, 1_000);

test("minting validates and freezes one snapshot of accessor claims", () => {
  let reads = 0;
  const claims: IdentityClaims = {
    issuer: "https://issuer.example",
    get subject() {
      return ++reads === 1 ? "person" : "";
    },
    audience: "forge",
    expiresAt: 2_000,
    authenticatedAt: 500,
  };
  const identity = mintIdentity(claims);
  expect(reads).toBe(1);
  expect(identity.subject).toBe("person");
  expect(Object.isFrozen(identity)).toBe(true);
  expect(isVerifiedIdentity(identity)).toBe(true);
}, 1_000);
