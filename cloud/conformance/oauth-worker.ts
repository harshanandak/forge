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
import { mintIdentity } from "../../src/ports/identity-mint.ts";
import { createWorker } from "../src/worker.ts";
export { CodeRedemption } from "../src/adapters/workers-oauth/compose.ts";

interface Env {
  OAUTH_KV: OAuthStorage;
  CODE_REDEMPTION: RedemptionNamespace;
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url),
      issuer = url.origin;
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
      storage: env.OAUTH_KV,
      codeRedemption: durableRedemption(env.CODE_REDEMPTION),
      clock: { now: Date.now },
      upstream: {
        begin: (state) =>
          Promise.resolve(`${issuer}/fixture/login?state=${state}`),
        verify: () =>
          Promise.resolve({
            ok: true,
            identity: mintIdentity({
              issuer: "https://identity.test",
              subject: "owner",
              audience: issuer,
              authenticatedAt: Date.now() - 1000,
              expiresAt: Date.now() + 7_200_000,
            }),
          }),
      },
    };
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
