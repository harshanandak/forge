import { expect, mock, test } from "bun:test";
import { createClerkBinding } from "../../../cloud/src/adapters/workers-oauth/clerk/index.ts";
import {
  createClerkUpstream,
  type ClerkHttpPort,
} from "../../../cloud/src/adapters/workers-oauth/clerk/upstream.ts";
import { createOidcVerifier } from "../../../src/adapters/oidc/index.ts";
import { createOAuthHarness } from "../workers-oauth/harness.ts";

await mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
const { createOAuthAdapter } =
  await import("../../../cloud/src/adapters/workers-oauth/index.ts");
const issuer = "https://clerk.example/",
  audience = "forge";
const config = {
  authorizationUrl: `${issuer}authorize`,
  tokenUrl: `${issuer}token`,
  redirectUri: "https://auth.example/callback",
  clientId: "forge-client",
  timeoutMs: 25,
};
const rsa = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
};
const keys = crypto.subtle.generateKey(rsa, true, ["sign", "verify"]);
const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const code = "code=recorded-code";
const response =
  (body: unknown, status = 200) =>
  () =>
    Promise.resolve(Response.json(body, { status }));
async function fixture(post?: ClerkHttpPort["post"]) {
  const harness = createOAuthHarness(),
    pair = await keys;
  const input = `${encode({ alg: "RS256", kid: "recorded" })}.${encode({ iss: issuer, sub: "person", aud: audience, auth_time: 500, exp: 2000 })}`;
  const signed = await crypto.subtle.sign(
    rsa,
    pair.privateKey,
    new TextEncoder().encode(input),
  );
  const proof = `${input}.${Buffer.from(signed).toString("base64url")}`;
  const jwk = {
    ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
    kid: "recorded",
  };
  const verifier = createOidcVerifier(
    {
      issuer,
      audience,
      algorithms: ["RS256"],
      jwksUrl: `${issuer}keys`,
      cacheTtlMs: 60_000,
      refreshIntervalMs: 1000,
      fetchTimeoutMs: 25,
    },
    { get: () => Promise.resolve(JSON.stringify({ keys: [jwk] })) },
    harness.options.clock,
  );
  const signals: AbortSignal[] = [];
  const upstream = createClerkUpstream(
    config,
    createClerkBinding(verifier, audience, harness.options.clock),
    {
      post: (url, body, signal) => {
        expect(url).toBe(config.tokenUrl);
        expect(Object.fromEntries(body)).toEqual({
          grant_type: "authorization_code",
          code: "recorded-code",
          client_id: config.clientId,
          redirect_uri: config.redirectUri,
        });
        signals.push(signal);
        return post ? post(url, body, signal) : response({ id_token: proof })();
      },
    },
    harness.options.clock,
  );
  const verify = (query: string) =>
    upstream.verify(
      new Request(`${config.redirectUri}?${query}`),
      harness.options.clock.now(),
    );
  async function callback(query: string) {
    harness.options.upstream = upstream;
    const api = createOAuthAdapter(harness.options);
    const redirect = "https://client.example/callback",
      clientId = await api.register(redirect);
    const cookies = new Map<string, string>();
    const keep = (r: Response) => {
      for (const cookie of r.headers.getSetCookie())
        cookies.set(cookie.split("=")[0]!, cookie.split(";")[0]!);
      return r;
    };
    const request = (url: string, body?: URLSearchParams) =>
      new Request(url, {
        headers: { cookie: [...cookies.values()].join("; ") },
        ...(body ? { method: "POST", body } : {}),
      });
    const authUrl = new URL("https://auth.example/authorize");
    authUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirect,
      state: "client-state",
      scope: "mcp:read",
      resource: "https://api.example/a",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
    }).toString();
    const auth = keep(await api.authorize(request(authUrl.href)));
    expect(auth.status).toBe(200);
    const { handle } = (await auth.json()) as { handle: string };
    const login = keep(
      await api.consent(
        request(
          authUrl.origin + authUrl.pathname,
          new URLSearchParams({ handle }),
        ),
        true,
      ),
    );
    expect(login.status).toBe(302);
    const state = new URL(login.headers.get("location")!).searchParams.get(
      "state",
    )!;
    return api.callback(
      request(
        `${config.redirectUri}?state=${encodeURIComponent(state)}&${query}`,
      ),
    );
  }
  return { verify, callback, signals };
}

test("real callback accepts the merged Clerk binding and returns a client authorization code", async () => {
  const f = await fixture();
  const result = await f.callback(code);
  expect(result.status).toBe(302);
  const target = new URL(result.headers.get("location")!);
  expect(target.origin).toBe("https://client.example");
  expect(target.searchParams.get("code")).toBeTruthy();
  expect(target.searchParams.get("state")).toBe("client-state");
}, 5_000);

const disconnected = () => Promise.reject(new Error("private"));
const stalled = () => new Promise<Response>(() => {});
const malformed = () => Promise.resolve(new Response("private"));
for (const [name, query, post, error] of [
  ["denial", "error=access_denied", undefined, "consent_denied"],
  [
    "upstream error",
    "error=server_error&code=private",
    undefined,
    "upstream_error",
  ],
  ["missing code", "", undefined, "malformed_response"],
  ["duplicate code", "code=a&code=b", undefined, "malformed_response"],
  ["outage", code, response("private", 503), "unavailable"],
  ["transport failure", code, disconnected, "unavailable"],
  ["timeout", code, stalled, "timeout"],
  ["invalid JSON", code, malformed, "malformed_response"],
  [
    "missing token",
    code,
    response({ access_token: "private" }),
    "malformed_response",
  ],
] as const) {
  test(`real OAuth callback refuses Clerk ${name}`, async () => {
    const f = await fixture(post);
    const result = await f.callback(query);
    expect(result.status).toBe(400);
    expect(await result.json()).toEqual({ error: "access_denied" });
    expect(result.headers.get("location")).toBeNull();
    expect(await f.verify(query)).toEqual({
      ok: false,
      reason: "invalid_proof",
      error,
    });
    if (!post) expect(f.signals).toHaveLength(0);
    else expect(f.signals).toHaveLength(2);
    if (name === "timeout")
      expect(f.signals.every((signal) => signal.aborted)).toBe(true);
  }, 5_000);
}
