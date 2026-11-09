import type {
  IdentityRefusal,
  IdentityVerifier,
  VerifiedIdentity,
} from "../../../src/ports/identity.ts";

/** Test-only opaque proofs; never use this fixture to authenticate real callers. */
export function testIdentityVerifier(
  proofs: ReadonlyMap<string, VerifiedIdentity>,
): IdentityVerifier {
  return {
    verify(proof, expectedAudience, now) {
      const identity =
        typeof proof === "string" ? proofs.get(proof) : undefined;
      if (identity === undefined)
        return Promise.resolve({ ok: false, reason: "invalid_proof" });
      let reason: IdentityRefusal | undefined;
      if (
        !Number.isFinite(now) ||
        !Number.isFinite(identity.expiresAt) ||
        !Number.isFinite(identity.authenticatedAt)
      )
        reason = "invalid_proof";
      else if (identity.issuer.length === 0) reason = "empty_issuer";
      else if (identity.subject.length === 0) reason = "empty_subject";
      else if (identity.audience !== expectedAudience) reason = "wrong_audience";
      else if (now >= identity.expiresAt) reason = "expired";
      return Promise.resolve(
        reason === undefined
          ? { ok: true, identity: { ...identity } }
          : { ok: false, reason },
      );
    },
  };
}
