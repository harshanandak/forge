import {
  composeAuth,
  configUnavailable,
  isOAuthRoute,
  ownerPolicy,
} from "../../auth/compose.ts";
import type { AuthorizationPort } from "../../../../src/ports/authorization.ts";
import { createOAuthAdapter, type OAuthOptions } from "./index.ts";
import { createWorker, type ProjectForward } from "../../worker.ts";
import { Project as BaseProject } from "../../project.ts";
import {
  isDeviceCallback,
  isDeviceRoute,
  type DeviceBrowserOptions,
} from "../../auth/device-browser.ts";
import type { ClockPort } from "../../../../src/ports/clock.ts";
import { OAuthConfigError, readOAuthConfig } from "./config.ts";
import {
  OAuthAuthorizationServer,
  type ConsentDescription,
} from "@cloudflare/workers-oauth-provider";
import {
  guardRegistration,
  isLoopbackRedirect,
  REGISTRATION_LIMITS,
} from "./registration.ts";
import { clerkUpstream, productionOptions } from "./production.ts";
import { bearer, sha256, wellFormed } from "../../tokens.ts";
import { durableRedemption, type RedemptionNamespace } from "./redemption.ts";
import { isLoginRoute } from "../../auth/project-login.ts";
import { commandProject } from "../../issue-commands.ts";
import { boundedOAuthRequest } from "./body.ts";
export { CodeRedemption } from "./redemption.ts";
export { RegistrationLimiter } from "./registration.ts";
/** The Clerk upstream and durable redemption the project object needs for owner approval; absent when unconfigured. */
function deviceBrowser(env: unknown): DeviceBrowserOptions {
  try {
    const vars = (env ?? {}) as Readonly<Record<string, unknown>>;
    const config = readOAuthConfig(
      vars,
      new URL(String(vars.CLERK_REDIRECT_URI)).origin,
    );
    const namespace = vars.CODE_REDEMPTION as RedemptionNamespace | undefined;
    return {
      upstream: clerkUpstream(config, {}),
      ...(typeof namespace?.idFromName === "function" &&
      typeof namespace.get === "function"
        ? { redemption: durableRedemption(namespace) }
        : {}),
    };
  } catch {
    return {};
  }
}
/** The deployed project object: the claim server, plus the browser approval of device logins. */
export class Project extends BaseProject {
  constructor(
    ctx: ConstructorParameters<typeof BaseProject>[0],
    env?: unknown,
  ) {
    super(ctx, env, deviceBrowser(env));
  }
}
export interface WorkerDependencies {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  clock?: ClockPort;
  policy?: AuthorizationPort;
  forward?: ProjectForward;
}

export function composeOAuth(
  options: OAuthOptions,
  resource: string,
  policy?: AuthorizationPort,
  team?: AuthorizationPort,
  protocol?: (request: Request) => Promise<Response>,
) {
  const adapter = createOAuthAdapter(options);
  return composeAuth(
    adapter,
    resource,
    policy,
    team,
    async (request) => {
      const path = new URL(request.url).pathname;
      if (
        request.method === "POST" &&
        ["/authorize", "/oauth/token"].includes(path)
      ) {
        const bounded = await boundedOAuthRequest(request);
        if (bounded instanceof Response) return bounded;
        request = bounded;
      }
      if (path === "/callback") return adapter.callback(request);
      if (path === "/oauth/token") return adapter.token(request);
      if (protocol) return protocol(request);
      if (path === "/authorize") {
        try {
          if (request.method === "POST")
            return await adapter.consent(
              request,
              (await request.clone().formData()).get("allow") === "true",
            );
          if (request.method !== "GET") throw new Error("Invalid method");
          const response = await adapter.authorize(request);
          if (!response.ok) return response;
          const { handle, consent } = (await response.json()) as {
            handle: string;
            consent: ConsentDescription;
          };
          const escape = (value: string) =>
            value
              .replaceAll("&", "&amp;")
              .replaceAll("<", "&lt;")
              .replaceAll(">", "&gt;")
              .replaceAll('"', "&quot;")
              .replaceAll("'", "&#39;");
          const headers = new Headers(response.headers);
          headers.set("Content-Type", "text/html; charset=utf-8");
          headers.set("Cache-Control", "no-store");
          headers.set("X-Frame-Options", "DENY");
          headers.set(
            "Content-Security-Policy",
            "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
          );
          headers.set("Referrer-Policy", "no-referrer");
          return new Response(
            `<!doctype html><html lang="en"><meta charset="utf-8"><title>Authorize access</title><h1>Authorize ${escape(consent.clientName || consent.clientId)}</h1><p>Redirect: <code>${escape(consent.redirectUri)}</code></p>${isLoopbackRedirect(consent.redirectUri) ? "<p>This app runs on this computer.</p>" : ""}<form method="post" action="/authorize"><input type="hidden" name="handle" value="${escape(handle)}"><button name="allow" value="true">Allow</button><button name="allow" value="false">Deny</button></form></html>`,
            { headers },
          );
        } catch {
          return Response.json(
            { error: "invalid_request" },
            { status: 400, headers: { "Cache-Control": "no-store" } },
          );
        }
      }
      return configUnavailable("OAUTH_COMPOSITION");
    },
    // The port is supplied explicitly; adapter methods never imply this capability.
    options.codeRedemption,
  );
}

export function createConfiguredWorker(
  protocol?: (request: Request) => Promise<Response>,
  input: WorkerDependencies = {},
) {
  const worker = createWorker();
  const dependencies = { ...input };
  return {
    async fetch(
      request: Request,
      env: Parameters<typeof worker.fetch>[1] &
        Readonly<Record<string, unknown>>,
    ) {
      const path = new URL(request.url).pathname;
      const token = bearer(request);
      if (
        isDeviceRoute(request) ||
        isDeviceCallback(request) ||
        commandProject(request) !== undefined ||
        (!isOAuthRoute(request) &&
          (isLoginRoute(request) ||
            !token ||
            wellFormed(token) ||
            /\/(devices|revoke|status|dump|restore)$/.test(path)))
      )
        return worker.fetch(request, env);
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
      if (
        !env.CODE_REDEMPTION ||
        !["idFromName", "get"].every(
          (key) =>
            typeof (env.CODE_REDEMPTION as Record<string, unknown>)[key] ===
            "function",
        )
      )
        return configUnavailable(
          "CODE_REDEMPTION",
          "Atomic redemption unavailable",
        );
      try {
        const auth = composeOAuth(
          productionOptions(config, env, dependencies),
          config.resource,
          dependencies.policy ??
            ownerPolicy(config.issuer, config.ownerSubject),
          undefined,
          protocol,
        );
        if (!isOAuthRoute(request)) {
          const forward: ProjectForward = async (
            request,
            project,
            { principal },
          ) => {
            if (principal.kind !== "person")
              throw new Error("Invalid principal");
            const headers = new Headers(request.headers);
            const identity = principal.identity;
            headers.set(
              "X-Forge-Owner",
              `oauth-owner:${await sha256(JSON.stringify([identity.issuer, identity.subject]))}`,
            );
            headers.set("X-Forge-Owner-Expires", String(identity.expiresAt));
            return env.PROJECTS.get(env.PROJECTS.idFromName(project)).fetch(
              new Request(request, { headers }),
            );
          };
          return createWorker(auth, dependencies.forward ?? forward).fetch(
            request,
            env,
          );
        }
        if (["/authorize", "/callback", "/oauth/token"].includes(path))
          return await auth.route(request);
        const refusal = await guardRegistration(
          request,
          env.REGISTRATION_LIMITER,
          config.namedRedirects,
        );
        if (refusal) return refusal;
        if (protocol) return await protocol(request);
        if (
          new URL(request.url).pathname ===
          "/.well-known/oauth-protected-resource"
        ) {
          if (!["GET", "HEAD"].includes(request.method))
            return Response.json(
              { error: { code: "METHOD_NOT_ALLOWED" } },
              { status: 405, headers: { Allow: "GET, HEAD" } },
            );
          return new Response(
            request.method === "HEAD"
              ? null
              : JSON.stringify({
                  resource: config.resource,
                  authorization_servers: [new URL(config.redirectUri).origin],
                }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        const server = new OAuthAuthorizationServer({
          issuer: new URL(config.redirectUri).origin,
          resources: [config.resource],
          clientIdMetadataDocumentEnabled: false,
          clientRegistrationEndpoint: "/register",
          clientRegistrationTTL: REGISTRATION_LIMITS.clientTTL,
        });
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
        return new URL(request.url).pathname === "/register" && !response.ok
          ? Response.json(
              { error: "invalid_client_metadata" },
              { status: response.status },
            )
          : response;
      } catch {
        return configUnavailable("OAUTH_PROTOCOL");
      }
    },
  };
}

export default createConfiguredWorker();
