import { expect, mock, test } from "bun:test";
import { singleOwnerPolicy } from "../../../src/ports/authorization.ts";
import {
  isVerifiedIdentity,
  type VerifiedIdentity,
} from "../../../src/ports/identity.ts";
import { testIdentityVerifier } from "../../contract/lib/identity-verifier.ts";
import { createOAuthHarness } from "../../adapters/workers-oauth/harness.ts";

await mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
const { createOAuthAdapter } =
  await import("../../../cloud/src/adapters/workers-oauth/index.ts");
const issuer = "https://auth.example",
  resource = "https://api.example/a";
const claims = {
  issuer: "https://identity.example",
  subject: "person",
  audience: issuer,
  authenticatedAt: 1_000_000,
  expiresAt: 4_600_000,
};

async function fixture() {
  const harness = createOAuthHarness(),
    api = createOAuthAdapter(harness.options);
  const redirect = "https://client.example/callback";
  const client = await api.register(redirect),
    cookies = new Map<string, string>();
  const request = (url: string, form?: Record<string, string>) =>
    new Request(url, {
      headers: { cookie: [...cookies.values()].join("; ") },
      ...(form ? { method: "POST", body: new URLSearchParams(form) } : {}),
    });
  const keep = (response: Response) => {
    for (const cookie of response.headers.getSetCookie())
      cookies.set(cookie.split("=")[0]!, cookie.split(";")[0]!);
    return response;
  };
  async function callback() {
    const consent = keep(
      await api.authorize(
        request(
          `${issuer}/authorize?${new URLSearchParams({
            response_type: "code",
            client_id: client,
            redirect_uri: redirect,
            state: "state",
            resource,
            code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
            code_challenge_method: "S256",
          })}`,
        ),
      ),
    );
    const { handle } = (await consent.json()) as { handle: string };
    const upstream = keep(
      await api.consent(request(`${issuer}/authorize`, { handle }), true),
    );
    const state = new URL(upstream.headers.get("location")!).searchParams.get(
      "state",
    )!;
    return api.callback(
      request(
        `${issuer}/callback?${new URLSearchParams({ state, proof: "proof" })}`,
      ),
    );
  }
  async function token() {
    const response = await callback();
    if (response.status !== 302) throw new Error("Fixture callback failed");
    const code = new URL(response.headers.get("location")!).searchParams.get(
      "code",
    )!;
    const exchanged = await api.token(
      request(`${issuer}/oauth/token`, {
        grant_type: "authorization_code",
        client_id: client,
        redirect_uri: redirect,
        code,
        resource,
        code_verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      }),
    );
    if (exchanged.status !== 200) throw new Error("Fixture exchange failed");
    return ((await exchanged.json()) as { access_token: string }).access_token;
  }
  return { ...harness, api, callback, token };
}

test("a provider token carries the verifier's exact issuer and subject", async () => {
  const f = await fixture(),
    token = await f.token();
  const identity = await f.api.verify(token, resource);
  expect(isVerifiedIdentity(identity)).toBe(true);
  expect(identity).toMatchObject({ ...claims, audience: resource });
  // A different instance must recover provenance from provider-validated storage.
  expect(await createOAuthAdapter(f.options).verify(token, resource)).toEqual(
    identity,
  );
}, 30_000);

test("wrong-resource, expired and forged credentials yield no identity", async () => {
  const f = await fixture(),
    token = await f.token();
  expect(await f.api.verify(token, "https://api.example/b")).toBeNull();
  expect(await f.api.verify(token, "https://unknown.example")).toBeNull();
  expect(
    await f.api.verify(JSON.stringify({ props: claims }), resource),
  ).toBeNull();
  expect(await f.api.verify("", resource)).toBeNull();
  f.advance();
  expect(await f.api.verify(token, resource)).toBeNull();
}, 30_000);

test("client identity headers and query props cannot replace the token identity", async () => {
  const f = await fixture(),
    token = await f.token();
  const request = new Request(
    `${resource}?subject=attacker&props=${encodeURIComponent(JSON.stringify(claims))}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        "x-identity-subject": "attacker",
        "x-forwarded-user": "attacker",
      },
    },
  );
  const presented = request.headers.get("authorization")!.slice(7);
  expect((await f.api.verify(presented, resource))?.subject).toBe("person");
  request.headers.delete("authorization");
  expect(
    await f.api.verify(request.headers.get("authorization") ?? "", resource),
  ).toBeNull();
}, 30_000);

test("a structurally forged upstream identity never creates a provider grant", async () => {
  const f = await fixture();
  f.options.upstream.verify = () =>
    Promise.resolve({ ok: true, identity: { ...claims } as VerifiedIdentity });
  expect((await f.callback()).status).toBe(400);
}, 30_000);

test("an upstream identity for another audience never creates a provider grant", async () => {
  const f = await fixture();
  const verifier = testIdentityVerifier(
    new Map([["proof", { ...claims, audience: "other" }]]),
  );
  f.options.upstream.verify = (_request, now) =>
    verifier.verify("proof", "other", now);
  expect((await f.callback()).status).toBe(400);
}, 30_000);

test("the open policy distinguishes an owner principal from a verified person", async () => {
  const input = {
    project: "project",
    action: "read",
    authority: "single-owner",
  } as const;
  expect(
    singleOwnerPolicy.authorize({
      ...input,
      principal: { kind: "single-owner" },
    }),
  ).toEqual({ allowed: true });
  const result = await testIdentityVerifier(
    new Map([["proof", claims]]),
  ).verify("proof", issuer, 1_000_000);
  if (!result.ok) throw new Error("Fixture identity failed");
  expect(
    singleOwnerPolicy.authorize({
      ...input,
      principal: { kind: "person", identity: result.identity },
    }),
  ).toEqual({ allowed: false, code: "AUTH_FORBIDDEN" });
}, 30_000);

test("an owner principal cannot bypass a missing team authorization provider", () => {
  expect(
    singleOwnerPolicy.authorize({
      project: "project",
      action: "read",
      authority: "team",
      principal: { kind: "single-owner" },
    }),
  ).toEqual({ allowed: false, code: "TEAM_AUTHORIZATION_UNAVAILABLE" });
}, 30_000);
