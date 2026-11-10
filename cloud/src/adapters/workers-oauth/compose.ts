import {
  composeAuth,
  configUnavailable,
  isOAuthRoute,
} from "../../auth/compose.ts";
import type { AuthorizationPort } from "../../../../src/ports/authorization.ts";
import { createOAuthAdapter, type OAuthOptions } from "./index.ts";
import { createWorker } from "../../worker.ts";
import { OAuthConfigError, readOAuthConfig } from "./config.ts";
import { OAuthAuthorizationServer } from "@cloudflare/workers-oauth-provider";
export { Project } from "../../worker.ts";

export function composeOAuth(
  options: OAuthOptions,
  resource: string,
  policy?: AuthorizationPort,
  team?: AuthorizationPort,
  protocol?: (request: Request) => Promise<Response>,
) {
  return composeAuth(
    createOAuthAdapter(options),
    resource,
    policy,
    team,
    protocol,
  );
}

export function createConfiguredWorker(
  protocol?: (request: Request) => Promise<Response>,
) {
  const worker = createWorker();
  return {
    async fetch(
      request: Request,
      env: Parameters<typeof worker.fetch>[1] &
        Readonly<Record<string, unknown>>,
    ) {
      if (!isOAuthRoute(request)) return worker.fetch(request, env);
      let config;
      try {
        config = readOAuthConfig(env, new URL(request.url).origin);
        const kv = env.OAUTH_KV;
        if (
          !kv ||
          !["get", "put", "delete", "list"].every(
            (key) => typeof (kv as Record<string, unknown>)[key] === "function",
          )
        )
          return configUnavailable("OAUTH_KV");
      } catch (error) {
        return configUnavailable(
          error instanceof OAuthConfigError
            ? error.variable
            : "OAUTH_CONFIGURATION",
        );
      }
      if (["/callback", "/oauth/token"].includes(new URL(request.url).pathname))
        return configUnavailable(
          "CODE_REDEMPTION",
          "Atomic redemption unavailable",
        );
      try {
        if (protocol) return await protocol(request);
        const server = new OAuthAuthorizationServer({
          issuer: new URL(request.url).origin,
          resources: [config.resource],
          clientIdMetadataDocumentEnabled: false,
        });
        // Authorization cannot begin an upstream exchange before atomic redemption is wired.
        if (new URL(request.url).pathname === "/authorize")
          return configUnavailable(
            "CODE_REDEMPTION",
            "Atomic redemption unavailable",
          );
        const tasks: Promise<unknown>[] = [];
        const response = await server.fetch(request, env, {
          waitUntil: (task: Promise<unknown>) => {
            tasks.push(task);
          },
          passThroughOnException: () => {
            throw new Error("Unsupported passthrough");
          },
          props: {},
        });
        await Promise.all(tasks);
        return response;
      } catch {
        return configUnavailable("OAUTH_PROTOCOL");
      }
    },
  };
}

export default createConfiguredWorker();
