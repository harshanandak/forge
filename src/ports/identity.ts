/** The exact (issuer, subject) pair identifies a principal; neither field is normalized. */
export interface VerifiedIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly audience: string;
  /** Milliseconds since the Unix epoch; valid only while now < expiresAt. */
  readonly expiresAt: number;
  /** Authentication time in milliseconds since the Unix epoch. */
  readonly authenticatedAt: number;
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
export interface IdentityVerifier {
  verify(
    proof: unknown,
    expectedAudience: string,
    now: number,
  ): Promise<IdentityResult>;
}
