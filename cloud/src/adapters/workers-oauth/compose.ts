import { composeAuth } from "../../auth/compose.ts";
import type { AuthorizationPort } from "../../../../src/ports/authorization.ts";
import { createOAuthAdapter, type OAuthOptions } from "./index.ts";
import { createWorker } from "../../worker.ts";

export function composeOAuth(
  options: OAuthOptions,
  resource: string,
  policy?: AuthorizationPort,
  team?: AuthorizationPort,
  _protocol?: (request: Request) => Promise<Response>,
) {
  return composeAuth(createOAuthAdapter(options), resource, policy, team);
}

export function createConfiguredWorker(
  _protocol?: (request: Request) => Promise<Response>,
) {
  return createWorker();
}
