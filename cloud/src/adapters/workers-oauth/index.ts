import {
  AuthorizationError,
  type Grant,
  OAuthAuthorizationServer,
} from "@cloudflare/workers-oauth-provider";
import type { ClockPort } from "../../../../src/ports/clock.ts";
import type { OAuthVerificationPort } from "../../../../src/ports/authorization.ts";
import { mintIdentity } from "../../../../src/ports/identity-mint.ts";
import {
  isVerifiedIdentity,
  type IdentityClaims,
  type IdentityResult,
  type VerifiedIdentity,
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
    begin(state: string, verifier?: string): Promise<string>;
    verify(
      request: Request,
      now: number,
      verifier?: string,
    ): Promise<IdentityResult & { readonly verifiedAudience?: string }>;
  };
}
export interface OAuthAdapter extends OAuthVerificationPort {
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
  async function verifyProviderToken(
    token: string,
    resource: string,
  ): Promise<VerifiedIdentity | null> {
    try {
      const validated = await server.validateToken<
        IdentityClaims & { verifiedAudience: string }
      >(resource, token, env);
      const now = options.clock.now();
      if (
        !validated ||
        validated.audience !== resource ||
        !Number.isFinite(now)
      )
        return null;
      const claims = validated.props;
      const expiresAt = Math.min(claims.expiresAt, validated.expiresAt * 1_000);
      if (
        claims.audience !== claims.verifiedAudience ||
        !Number.isFinite(expiresAt) ||
        now >= expiresAt ||
        now < claims.authenticatedAt ||
        validated.userId !==
          encodeURIComponent(JSON.stringify([claims.issuer, claims.subject]))
      )
        return null;
      return mintIdentity({ ...claims, audience: resource, expiresAt });
    } catch {
      return null;
    }
  }
  const refusal = (code: "invalid_request" | "access_denied") =>
    new AuthorizationError(code, { description: code });
  const failure = (error: string, status: number): Response =>
    Response.json(
      { error },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  const guarded = async (
    operation: () => Promise<Response>,
  ): Promise<Response> => {
    try {
      return await operation();
    } catch (error) {
      const invalid = error instanceof AuthorizationError;
      return failure(
        invalid ? error.code : "temporarily_unavailable",
        invalid ? 400 : 503,
      );
    }
  };
  return {
    verify: verifyProviderToken,
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
        const verifier = Buffer.from(
          crypto.getRandomValues(new Uint8Array(32)),
        ).toString("base64url");
        const expiresAt = options.clock.now() + 600_000;
        if (!Number.isFinite(expiresAt)) throw refusal("access_denied");
        const { state, headers } = await oauth.beginUpstream(approved.request, {
          data: { verifier, expiresAt },
          headers: approved.headers,
        });
        headers.set("Location", await options.upstream.begin(state, verifier));
        return new Response(null, { status: 302, headers });
      }),
    callback: (request) =>
      guarded(async () => {
        const original = await oauth.finishUpstream<{
          verifier: string;
          expiresAt: number;
        }>(request);
        const data = original.data,
          at = options.clock.now();
        if (
          !data ||
          typeof data.verifier !== "string" ||
          !/^[\w-]{43}$/.test(data.verifier) ||
          !Number.isFinite(at) ||
          !Number.isFinite(data.expiresAt) ||
          at >= data.expiresAt
        )
          throw refusal("access_denied");
        // KV consumption is not atomic; reuse the existing atomic redemption port.
        const hash = Buffer.from(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(`upstream:${data.verifier}`),
          ),
        ).toString("hex");
        if (!(await options.codeRedemption.claimOnce(hash, data.expiresAt)))
          throw refusal("access_denied");
        const result = await options.upstream.verify(
          request,
          options.clock.now(),
          data.verifier,
        );
        const now = options.clock.now();
        if (
          !result.ok ||
          !isVerifiedIdentity(result.identity) ||
          result.identity.audience !==
            (result.verifiedAudience ?? options.issuer) ||
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
          props: {
            ...result.identity,
            verifiedAudience: result.verifiedAudience ?? options.issuer,
          },
        });
        original.headers.set("Location", redirectTo);
        return new Response(null, { status: 302, headers: original.headers });
      }),
    token: (request) =>
      guarded(async () => {
        const contentType = request.headers.get("Content-Type") ?? "";
        if (
          request.method === "POST" &&
          contentType.split(";")[0]?.trim().toLowerCase() ===
            "application/x-www-form-urlencoded"
        ) {
          const form = await request.clone().formData();
          if (form.get("grant_type") === "authorization_code") {
            const code = form.get("code");
            if (typeof code !== "string" || !code)
              throw refusal("invalid_request");
            const digest = await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(code),
            );
            const hash = Array.from(new Uint8Array(digest), (byte) =>
              byte.toString(16).padStart(2, "0"),
            ).join("");
            // Provider codes live 600s; keep the tombstone from redemption, not issuance.
            const expiresAt = options.clock.now() + 600_000;
            if (!Number.isFinite(expiresAt))
              throw new Error("Invalid claim deadline");
            if (!(await options.codeRedemption.claimOnce(hash, expiresAt))) {
              try {
                const [userId, grantId, secret, extra] = code.split(":");
                const clientId = form.get("client_id");
                // This port registers public clients only; refuse ambiguous authentication.
                if (
                  userId &&
                  grantId &&
                  secret &&
                  extra === undefined &&
                  typeof clientId === "string" &&
                  ["code", "grant_type", "client_id"].every(
                    (key) => form.getAll(key).length === 1,
                  ) &&
                  !request.headers.has("Authorization") &&
                  [
                    "client_secret",
                    "client_assertion",
                    "client_assertion_type",
                  ].every((key) => !form.has(key)) &&
                  (await oauth.lookupClient(clientId))
                    ?.tokenEndpointAuthMethod === "none"
                ) {
                  // No provider helper exposes authCodeId; listUserGrants omits it.
                  const grant = await options.storage.get<
                    Pick<Grant, "authCodeId" | "clientId">
                  >(`grant:${userId}:${grantId}`, { type: "json" });
                  if (
                    grant?.authCodeId === hash &&
                    grant.clientId === clientId
                  ) {
                    // Provider 1.2.4 has no revocation tombstone: an in-flight first
                    // exchange can persist tokens after this sweep. Claim still limits issuance to one.
                    await oauth.revokeGrant(grantId, userId);
                  }
                }
              } catch {
                // Lookup/revocation failure must never resume exchange or expose the code.
              }
              return failure("invalid_grant", 400);
            }
          }
        }
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
    accepts: async (token, resource) =>
      (await verifyProviderToken(token, resource)) !== null,
  };
}
