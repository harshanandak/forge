import type * as Auth from "../../../src/ports/authorization.ts";
import { singleOwnerPolicy } from "../../../src/ports/authorization.ts";
import { isVerifiedIdentity } from "../../../src/ports/identity.ts";
import { ForgeFailure } from "../../../src/contract/failure.ts";
import { bearer } from "../tokens.ts";

const durablePorts = new WeakSet<object>();
// Only durableRedemption may call this registration function.
export function registerDurableRedemption<T extends object>(port: T): T {
  durablePorts.add(port);
  return port;
}

export const isOAuthRoute = (request: Request) =>
  /^\/(authorize|callback|oauth\/token|register|\.well-known\/oauth-(authorization-server|protected-resource))$/.test(
    new URL(request.url).pathname,
  );
export const configUnavailable = (
  variable: string,
  message = "OAuth configuration unavailable",
) =>
  Response.json(
    { error: { code: "AUTH_CONFIG_UNAVAILABLE", variable, message } },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );

export interface Access {
  readonly principal: Auth.Principal;
  readonly decision: Auth.AuthorizationDecision;
}
export const ownerPolicy = (
  issuer: string,
  subject?: string,
): Auth.AuthorizationPort => ({
  authorize: (request) => {
    const { principal, authority } = request;
    return authority !== "team" &&
      subject !== undefined &&
      principal.kind === "person" &&
      isVerifiedIdentity(principal.identity) &&
      principal.identity.issuer === issuer &&
      principal.identity.subject === subject
      ? { allowed: true }
      : singleOwnerPolicy.authorize(request);
  },
});
export type AuthComposition = ReturnType<typeof composeAuth>;
export function composeAuth(
  oauth: Auth.OAuthVerificationPort | undefined,
  resource: string,
  policy: Auth.AuthorizationPort = singleOwnerPolicy,
  team?: Auth.AuthorizationPort,
  route: (request: Request) => Promise<Response> = () =>
    Promise.resolve(configUnavailable("OAUTH_COMPOSITION")),
  atomicRedemption?: {
    claimOnce(codeHash: string, expiresAt: number): Promise<boolean>;
  },
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
  return {
    authorize,
    mcp: authorize,
    policy,
    route: async (request: Request) => {
      if (
        !(atomicRedemption && durablePorts.has(atomicRedemption)) &&
        ["/callback", "/oauth/token"].includes(new URL(request.url).pathname)
      )
        return configUnavailable(
          "CODE_REDEMPTION",
          "Atomic redemption unavailable",
        );
      return route(request);
    },
  };
}
