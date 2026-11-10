import {
  AuthorizationError,
  OAuthAuthorizationServer,
} from "@cloudflare/workers-oauth-provider";
import type { ClockPort } from "../../../../src/ports/clock.ts";
import {
  isVerifiedIdentity,
  type IdentityResult,
} from "../../../../src/ports/identity.ts";

export interface OAuthStorage {
  get<T = string>(key: string, options?: { type: "json" }): Promise<T | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number; metadata?: unknown },
  ): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string }): Promise<{
    keys: { name: string; metadata?: unknown }[];
    list_complete: boolean;
  }>;
}
/**
 * Strongly consistent, atomic across all instances and regions. Production composition
 * must back this with a Durable Object, not KV or an in-process lock. Retain claims
 * through expiresAt (UTC milliseconds); reject if unavailable. No release: a successful
 * claim burns the code even when later exchange validation fails.
 */
export interface CodeRedemption {
  claimOnce(codeHash: string, expiresAt: number): Promise<boolean>;
}
export interface OAuthOptions {
  issuer: string;
  resources: readonly string[];
  storage: OAuthStorage;
  codeRedemption: CodeRedemption;
  clock: ClockPort;
  upstream: {
    begin(state: string): Promise<string>;
    verify(request: Request, now: number): Promise<IdentityResult>;
  };
}
export interface OAuthAdapter {
  register(redirectUri: string): Promise<string>;
  authorize(request: Request): Promise<Response>;
  consent(request: Request, allow: boolean): Promise<Response>;
  callback(request: Request): Promise<Response>;
  token(request: Request): Promise<Response>;
  accepts(
    token: Parameters<OAuthAuthorizationServer["validateToken"]>[1],
    resource: Parameters<OAuthAuthorizationServer["validateToken"]>[0],
  ): Promise<boolean>;
}

export function createOAuthAdapter(options: OAuthOptions): OAuthAdapter {
  const env = { OAUTH_KV: options.storage };
  const server = new OAuthAuthorizationServer<typeof env>({
    issuer: options.issuer,
    resources: options.resources,
    clientIdMetadataDocumentEnabled: false,
  });
  const oauth = server.getOAuthApi(env);
  const refusal = (code: "invalid_request" | "access_denied") =>
    new AuthorizationError(code, { description: code });
  const guarded = async (
    operation: () => Promise<Response>,
  ): Promise<Response> => {
    try {
      return await operation();
    } catch (error) {
      const invalid = error instanceof AuthorizationError;
      return Response.json(
        { error: invalid ? error.code : "temporarily_unavailable" },
        {
          status: invalid ? 400 : 503,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }
  };
  return {
    register: async (redirectUri) =>
      (
        await oauth.createClient({
          redirectUris: [redirectUri],
          tokenEndpointAuthMethod: "none",
        })
      ).clientId,
    authorize: (request) =>
      guarded(async () => {
        const parsed = await oauth.parseAuthRequest(request);
        const { handle, headers } = await oauth.beginConsent(parsed);
        return Response.json(
          { handle, consent: await oauth.describeConsent(parsed) },
          { headers },
        );
      }),
    consent: (request, allow) =>
      guarded(async () => {
        if (request.method !== "POST") throw refusal("invalid_request");
        const handle = (await request.formData()).get("handle");
        if (typeof handle !== "string") throw refusal("invalid_request");
        if (!allow)
          return new Response(null, {
            status: 302,
            headers: (await oauth.denyConsent(request, handle)).headers,
          });
        const approved = await oauth.approveConsent(request, handle);
        const { state, headers } = await oauth.beginUpstream(approved.request, {
          headers: approved.headers,
        });
        headers.set("Location", await options.upstream.begin(state));
        return new Response(null, { status: 302, headers });
      }),
    callback: (request) =>
      guarded(async () => {
        const original = await oauth.finishUpstream(request);
        const result = await options.upstream.verify(
          request,
          options.clock.now(),
        );
        const now = options.clock.now();
        if (
          !result.ok ||
          !isVerifiedIdentity(result.identity) ||
          !Number.isFinite(now) ||
          now >= result.identity.expiresAt ||
          now < result.identity.authenticatedAt
        )
          throw refusal("access_denied");
        const { issuer, subject } = result.identity;
        const { redirectTo } = await oauth.completeAuthorization({
          request: original.request,
          userId: encodeURIComponent(JSON.stringify([issuer, subject])),
          metadata: {},
          scope: original.request.scope,
          props: { issuer, subject },
        });
        original.headers.set("Location", redirectTo);
        return new Response(null, { status: 302, headers: original.headers });
      }),
    token: (request) =>
      guarded(async () => {
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
      }),
    accepts: async (token, resource) => {
      try {
        return (
          (await server.validateToken<unknown>(resource, token, env)) !== null
        );
      } catch {
        return false;
      }
    },
  };
}
