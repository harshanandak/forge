// CI-only upstream identity and KV snapshots. Never imported by the production entry.
import { composeOAuth } from "../src/adapters/workers-oauth/compose.ts";
import {
  createOAuthAdapter,
  type OAuthOptions,
  type OAuthStorage,
} from "../src/adapters/workers-oauth/index.ts";
import {
  durableRedemption,
  type RedemptionNamespace,
} from "../src/adapters/workers-oauth/redemption.ts";
import { clerk } from "./fault-worker.ts";
import { durableGrants } from "../src/adapters/workers-oauth/grant-state.ts";
import { createWorker } from "../src/worker.ts";
export {
  CodeRedemption,
  GrantState,
} from "../src/adapters/workers-oauth/compose.ts";

interface Env {
  OAUTH_KV: OAuthStorage;
  CODE_REDEMPTION: RedemptionNamespace;
  GRANT_STATE: RedemptionNamespace;
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url),
      issuer = url.origin;
    const upstream = clerk({
      CLERK_CLIENT_ID: issuer,
      CLERK_ISSUER: "https://clerk.test",
      FORGE_OWNER_SUBJECT: "user_ConformanceOwner",
    });
    if (url.pathname === "/fixture/ready") return new Response("ready");
    if (url.pathname === "/fixture/snapshot") {
      const entries = await env.OAUTH_KV.list({ prefix: "" });
      return Response.json(
        await Promise.all(
          entries.keys.map(async ({ name }) => [
            name,
            await env.OAUTH_KV.get(name),
          ]),
        ),
      );
    }
    if (url.pathname === "/fixture/restore") {
      const entries = (await request.json()) as [string, string][];
      for (const [key, value] of entries) await env.OAUTH_KV.put(key, value);
      return new Response(null, { status: 204 });
    }
    const options: OAuthOptions = {
      issuer,
      resources: [issuer],
      storage: {
        get: <T>(key: string, options?: { type: "json" }) =>
          request.headers.has("x-oauth-token-read-fault") &&
          key.startsWith("token:")
            ? Promise.reject(new Error("fixture token-record failure"))
            : env.OAUTH_KV.get<T>(key, options),
        put: (...args) => env.OAUTH_KV.put(...args),
        delete: (key) => env.OAUTH_KV.delete(key),
        list: (options) => env.OAUTH_KV.list(options),
      },
      codeRedemption: durableRedemption(env.CODE_REDEMPTION),
      grantRevocation: durableGrants(env.GRANT_STATE),
      clock: { now: Date.now },
      upstream: {
        begin: (state) =>
          Promise.resolve(`${issuer}/fixture/login?state=${state}`),
        verify: (request, now, verifier) =>
          upstream.verify(request, now, verifier ?? ""),
      },
    };
    const fault = request.headers.get("x-oauth-state-fault");
    if (fault)
      options.grantRevocation = durableGrants({
        idFromName: (name) => env.GRANT_STATE.idFromName(name),
        get: (id) => ({
          fetch: (input) => {
            if (
              fault === "stub" ||
              (fault === "read" && input.method === "GET") ||
              (fault === "write" && input.method === "POST")
            )
              return Promise.reject(new Error("fixture private fault"));
            return env.GRANT_STATE.get(id).fetch(input);
          },
        }),
      });
    const adapter = createOAuthAdapter(options);
    if (url.pathname === "/fixture/register")
      return Response.json({
        client: await adapter.register("http://127.0.0.1:9999/callback"),
      });
    if (url.pathname === "/fixture/verify") {
      const token = request.headers.get("Authorization")?.slice(7) ?? "";
      return Response.json({
        verified: (await adapter.verify(token, issuer)) !== null,
        accepts: await adapter.accepts(token, issuer),
      });
    }
    const auth = composeOAuth(options, issuer, {
      authorize: () => ({ allowed: true }),
    });
    if (url.pathname.startsWith("/p/"))
      return createWorker(auth, () =>
        Promise.resolve(new Response("owner access")),
      ).fetch(request, {
        PROJECTS: {
          idFromName: (name) => name,
          get: () => ({
            fetch: () =>
              Promise.resolve(new Response("unused", { status: 500 })),
          }),
        },
      });
    return auth.route(request);
  },
};
