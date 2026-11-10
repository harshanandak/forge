import type * as Auth from "../../../src/ports/authorization.ts";
import { singleOwnerPolicy } from "../../../src/ports/authorization.ts";
import { isVerifiedIdentity } from "../../../src/ports/identity.ts";
import { ForgeFailure } from "../../../src/contract/failure.ts";
import { bearer } from "../tokens.ts";

export interface Access {
  readonly principal: Auth.Principal;
  readonly decision: Auth.AuthorizationDecision;
}
export type AuthComposition = ReturnType<typeof composeAuth>;
export function composeAuth(
  oauth: Auth.OAuthVerificationPort | undefined,
  resource: string,
  policy: Auth.AuthorizationPort = singleOwnerPolicy,
  team?: Auth.AuthorizationPort,
) {
  const authorize = async (
    request: Request,
    project: string,
    action: string,
    authority: Auth.AuthorizationRequest["authority"] = "single-owner",
  ): Promise<Access> => {
    const identity = await oauth
      ?.verify(bearer(request) ?? "", resource)
      .catch(() => null);
    if (!isVerifiedIdentity(identity) || identity.audience !== resource)
      throw new ForgeFailure({
        code: "AUTH_INVALID",
        message: "Token is not valid",
        retry: "never",
      });
    const principal = { kind: "person", identity } as const;
    return {
      principal,
      decision: (authority === "team"
        ? (team ?? singleOwnerPolicy)
        : policy
      ).authorize({ principal, project, action, authority }),
    };
  };
  return { authorize, mcp: authorize, policy };
}
