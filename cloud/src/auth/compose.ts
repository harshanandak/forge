import type * as Auth from "../../../src/ports/authorization.ts";
import { singleOwnerPolicy } from "../../../src/ports/authorization.ts";
import type { OAuthAdapter } from "../adapters/workers-oauth/index.ts";

export interface Access {
  readonly principal: Auth.Principal;
  readonly decision: Auth.AuthorizationDecision;
}
export type AuthComposition = ReturnType<typeof composeAuth>;
export function composeAuth(
  _oauth: OAuthAdapter | undefined,
  _resource: string,
  policy: Auth.AuthorizationPort = singleOwnerPolicy,
  _oauthFetch?: (request: Request) => Promise<Response>,
  _teamAuthorization?: Auth.AuthorizationPort,
) {
  const authorize = (
    _request: Request,
    _project: string,
    _action: string,
    _authority?: Auth.AuthorizationRequest["authority"],
  ): Promise<Access> =>
    Promise.reject(new Error("Composition not implemented"));
  return {
    authorize,
    mcp: authorize,
    policy,
    route: (_request: Request) =>
      Promise.resolve(new Response(null, { status: 503 })),
  };
}
