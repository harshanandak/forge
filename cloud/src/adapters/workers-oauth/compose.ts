import { composeAuth } from "../../auth/compose.ts";
import type { AuthorizationPort } from "../../../../src/ports/authorization.ts";
import { createOAuthAdapter, type OAuthOptions } from "./index.ts";

export function composeOAuth(
  options: OAuthOptions,
  resource: string,
  policy?: AuthorizationPort,
  team?: AuthorizationPort,
) {
  return composeAuth(createOAuthAdapter(options), resource, policy, team);
}
