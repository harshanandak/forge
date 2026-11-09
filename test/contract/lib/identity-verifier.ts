import type {
  IdentityVerifier,
  VerifiedIdentity,
} from "../../../src/ports/identity.ts";

/** Test-only opaque proofs; never use this fixture to authenticate real callers. */
export function testIdentityVerifier(
  _proofs: ReadonlyMap<string, VerifiedIdentity>,
): IdentityVerifier {
  return {
    verify: () => Promise.resolve({ ok: false, reason: "invalid_proof" }),
  };
}
