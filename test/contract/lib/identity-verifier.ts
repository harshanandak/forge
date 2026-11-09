import { mintIdentity } from "../../../src/ports/identity-mint.ts";
import {
  type IdentityClaims,
  type IdentityRefusal,
  IdentityVerifier,
  type IdentityResult,
} from "../../../src/ports/identity.ts";

function validClaims(value: unknown): value is IdentityClaims {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const claims = value as Record<string, unknown>;
  const fields = [
    "issuer",
    "subject",
    "audience",
    "expiresAt",
    "authenticatedAt",
  ];
  return (
    Reflect.ownKeys(claims).length === fields.length &&
    fields.every((field) => Object.hasOwn(claims, field)) &&
    typeof claims.issuer === "string" &&
    typeof claims.subject === "string" &&
    typeof claims.audience === "string" &&
    typeof claims.expiresAt === "number" &&
    Number.isFinite(claims.expiresAt) &&
    typeof claims.authenticatedAt === "number" &&
    Number.isFinite(claims.authenticatedAt)
  );
}

/** Test-only opaque proofs; never use this fixture to authenticate real callers. */
export function testIdentityVerifier(
  proofs: ReadonlyMap<string, IdentityClaims>,
): IdentityVerifier {
  return new (class extends IdentityVerifier {
    verify(
      proof: unknown,
      expectedAudience: string,
      now: number,
    ): Promise<IdentityResult> {
      const identity =
        typeof proof === "string" ? proofs.get(proof) : undefined;
      if (!validClaims(identity) || !Number.isFinite(now))
        return Promise.resolve({ ok: false, reason: "invalid_proof" });
      let reason: IdentityRefusal | undefined;
      if (identity.issuer.length === 0) reason = "empty_issuer";
      else if (identity.subject.length === 0) reason = "empty_subject";
      else if (identity.audience !== expectedAudience)
        reason = "wrong_audience";
      else if (now >= identity.expiresAt) reason = "expired";
      return Promise.resolve(
        reason === undefined
          ? { ok: true, identity: mintIdentity(identity) }
          : { ok: false, reason },
      );
    }
  })();
}
