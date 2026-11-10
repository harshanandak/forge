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

// Tests-first stub; the policy is implemented only after CI demonstrates red.
export const singleOwnerPolicy: AuthorizationPort = {
  authorize: () => ({ allowed: false, code: "AUTH_FORBIDDEN" }),
};
