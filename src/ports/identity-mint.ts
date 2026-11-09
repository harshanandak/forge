import type { IdentityClaims, VerifiedIdentity } from "./identity.ts";

const minted = new WeakSet<object>();

/** Call only after authenticating proof and validating every claim. */
export function mintIdentity(claims: IdentityClaims): VerifiedIdentity {
  const identity = Object.freeze({
    issuer: claims.issuer,
    subject: claims.subject,
    audience: claims.audience,
    expiresAt: claims.expiresAt,
    authenticatedAt: claims.authenticatedAt,
  }) as VerifiedIdentity;
  minted.add(identity);
  return identity;
}

export function isVerifiedIdentity(value: unknown): value is VerifiedIdentity {
  return typeof value === "object" && value !== null && minted.has(value);
}
