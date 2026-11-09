import type { IdentityClaims, VerifiedIdentity } from "./identity.ts";

const minted = new WeakSet<object>();

/** Call only after authenticating proof and validating every claim. */
export function mintIdentity(claims: IdentityClaims): VerifiedIdentity {
  if (typeof claims !== "object" || claims === null)
    throw new TypeError("Invalid identity claims");
  const { issuer, subject, audience, expiresAt, authenticatedAt } = claims;
  if (
    typeof issuer !== "string" ||
    issuer.length === 0 ||
    typeof subject !== "string" ||
    subject.length === 0 ||
    typeof audience !== "string" ||
    typeof expiresAt !== "number" ||
    !Number.isFinite(expiresAt) ||
    typeof authenticatedAt !== "number" ||
    !Number.isFinite(authenticatedAt)
  )
    throw new TypeError("Invalid identity claims");
  const identity = Object.freeze({
    issuer,
    subject,
    audience,
    expiresAt,
    authenticatedAt,
  }) as VerifiedIdentity;
  minted.add(identity);
  return identity;
}

export function isVerifiedIdentity(value: unknown): value is VerifiedIdentity {
  return typeof value === "object" && value !== null && minted.has(value);
}
