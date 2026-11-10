import type { VerifiedIdentity } from "./identity.ts";

export type Principal =
  | { readonly kind: "single-owner" }
  | { readonly kind: "person"; readonly identity: VerifiedIdentity };

export interface AuthorizationRequest {
  readonly principal: Principal;
  readonly project: string;
  readonly action: string;
  readonly authority: "single-owner" | "team";
}
export type AuthorizationDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly code: "AUTH_FORBIDDEN" | "TEAM_AUTHORIZATION_UNAVAILABLE";
    };
export interface AuthorizationPort {
  authorize(request: AuthorizationRequest): AuthorizationDecision;
}
/** Resource-bound provider proof; invalid or expired tokens return null. */
export interface OAuthVerificationPort {
  verify(token: string, resource: string): Promise<VerifiedIdentity | null>;
}
export const singleOwnerPolicy: AuthorizationPort = {
  authorize: ({ principal, authority }) =>
    authority === "team"
      ? { allowed: false, code: "TEAM_AUTHORIZATION_UNAVAILABLE" }
      : principal.kind === "single-owner"
        ? { allowed: true }
        : { allowed: false, code: "AUTH_FORBIDDEN" },
};
