/** The exact (issuer, subject) pair identifies a principal; neither field is normalized. */
export interface IdentityClaims {
  readonly issuer: string;
  readonly subject: string;
  readonly audience: string;
  /** Milliseconds since the Unix epoch; valid only while now < expiresAt. */
  readonly expiresAt: number;
  /** Authentication time in milliseconds since the Unix epoch. */
  readonly authenticatedAt: number;
}

declare const verified: unique symbol;
export interface VerifiedIdentity extends IdentityClaims {
  readonly [verified]: true;
}

export type IdentityRefusal =
  | "invalid_proof"
  | "empty_issuer"
  | "empty_subject"
  | "wrong_audience"
  | "expired";

export type IdentityResult =
  | { readonly ok: true; readonly identity: VerifiedIdentity }
  | { readonly ok: false; readonly reason: IdentityRefusal };

/**
 * Authenticate opaque proof using configured trust roots before returning identity.
 * Refuse empty identity fields, a different audience, and now >= expiresAt.
 */
export abstract class IdentityVerifier {
  /** Trusted verifiers mint this only after authenticating the proof. */
  protected identity(claims: IdentityClaims): VerifiedIdentity {
    return Object.freeze({ ...claims }) as VerifiedIdentity;
  }

  abstract verify(
    proof: unknown,
    expectedAudience: string,
    now: number,
  ): Promise<IdentityResult>;
}

export function isVerifiedIdentity(
  _value: unknown,
): _value is VerifiedIdentity {
  return false;
}
