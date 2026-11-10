import { expect, mock, test } from "bun:test";
import { createOAuthHarness } from "./harness.ts";

await mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
const { createOAuthAdapter } =
  await import("../../../cloud/src/adapters/workers-oauth/index.ts");
const issuer = "https://auth.example";
const resource = "https://api.example/a",
  other = "https://api.example/b";
const redirect = "https://client.example/callback?channel=desktop";
const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

async function fixture(identityTtlMs = 3_600_000) {
  const harness = createOAuthHarness(identityTtlMs);
  const api = createOAuthAdapter(harness.options);
  const client = await api.register(redirect),
    second = await api.register(redirect);
  const cookies = new Map<string, string>();
  const request = (url: string, form?: Record<string, string>) =>
    new Request(url, {
      headers: { cookie: [...cookies.values()].join("; ") },
      ...(form ? { method: "POST", body: new URLSearchParams(form) } : {}),
    });
  function keep(response: Response, status: number): Response {
    expect(response.status).toBe(status);
    for (const cookie of response.headers.getSetCookie())
      cookies.set(cookie.split("=")[0]!, cookie.split(";")[0]!);
    return response;
  }
  const authorization = (patch: Record<string, string> = {}) =>
    request(
      `${issuer}/authorize?${new URLSearchParams({ response_type: "code", client_id: client, redirect_uri: redirect, state: "client-state", scope: "mcp:read", resource, code_challenge: challenge, code_challenge_method: "S256", ...patch })}`,
    );
  async function consent() {
    const body = (await keep(
      await api.authorize(authorization()),
      200,
    ).json()) as { handle: string };
    return request(`${issuer}/authorize`, { handle: body.handle });
  }
  async function upstream() {
    const response = keep(await api.consent(await consent(), true), 302);
    const state = new URL(response.headers.get("location")!).searchParams.get(
      "state",
    )!;
    return new URL(
      `${issuer}/callback?${new URLSearchParams({ state, proof: "proof" })}`,
    );
  }
  async function code() {
    const response = keep(
      await api.callback(request((await upstream()).href)),
      302,
    );
    const target = new URL(response.headers.get("location")!);
    expect(target.searchParams.get("state")).toBe("client-state");
    expect(target.searchParams.get("code")).toBeTruthy();
    return target.searchParams.get("code")!;
  }
  const exchange = (value: string, patch: Record<string, string> = {}) =>
    api.token(
      new Request(`${issuer}/oauth/token`, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: client,
          redirect_uri: redirect,
          code: value,
          code_verifier: verifier,
          resource,
          ...patch,
        }),
      }),
    );
  return {
    api,
    options: harness.options,
    authorization,
    consent,
    upstream,
    code,
    exchange,
    request,
    second,
    keep,
    advance: (milliseconds?: number) => harness.advance(milliseconds),
  };
}

test("consent issues a resource-bound token and a code cannot be used twice", async () => {
  const f = await fixture(),
    code = await f.code();
  const body = (await f.keep(await f.exchange(code), 200).json()) as {
    access_token: string;
  };
  expect(body.access_token).toBeTruthy();
  expect(await f.api.accepts(body.access_token, resource)).toBe(true);
  expect(await f.api.accepts(body.access_token, other)).toBe(false);
  expect((await f.exchange(code)).status).toBe(400);
  expect(await f.api.accepts(body.access_token, resource)).toBe(false);
}, 30_000);

test("repeated wrong secrets do not revoke the real grant", async () => {
  const f = await fixture(),
    code = await f.code();
  const body = (await f.keep(await f.exchange(code), 200).json()) as {
    access_token: string;
  };
  expect(await f.api.accepts(body.access_token, resource)).toBe(true);
  const forged = `${code.slice(0, code.lastIndexOf(":") + 1)}wrongsecret`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = f.keep(await f.exchange(forged), 400);
    expect(((await response.json()) as { error: string }).error).toBe(
      "invalid_grant",
    );
    expect(await f.api.accepts(body.access_token, resource)).toBe(true);
  }
}, 30_000);

for (const [name, value, error] of [
  ["missing", "", "invalid_request"],
  ["wrong", "x".repeat(43), "invalid_grant"],
]) {
  test(`${name} PKCE verifier is refused`, async () => {
    const f = await fixture();
    const response = f.keep(
      await f.exchange(await f.code(), { code_verifier: value! }),
      400,
    );
    expect(((await response.json()) as { error: string }).error).toBe(error!);
  }, 30_000);
}
for (const redirect_uri of [
  "https://client.example/call",
  "https://client.example/callback/extra?channel=desktop",
  "https://client.example/callback?channel=other",
]) {
  test(`unregistered redirect ${redirect_uri} is refused`, async () => {
    const f = await fixture();
    expect(
      (await f.api.authorize(f.authorization({ redirect_uri }))).status,
    ).toBe(400);
  }, 30_000);
}
test("plain PKCE is refused", async () => {
  const f = await fixture();
  expect(
    (await f.api.authorize(f.authorization({ code_challenge_method: "plain" })))
      .status,
  ).toBe(400);
}, 30_000);
test("consent denial returns access_denied and no code", async () => {
  const f = await fixture();
  const response = f.keep(await f.api.consent(await f.consent(), false), 302);
  const target = new URL(response.headers.get("location")!);
  expect(target.searchParams.get("error")).toBe("access_denied");
  expect(target.searchParams.get("code")).toBeNull();
}, 30_000);
for (const state of ["", "changed"]) {
  test(`callback with ${state || "missing"} state is refused`, async () => {
    const f = await fixture(),
      url = await f.upstream();
    url.searchParams.set("state", state);
    expect((await f.api.callback(f.request(url.href))).status).toBe(400);
  }, 30_000);
}
test("client B cannot redeem client A's code", async () => {
  const f = await fixture();
  const response = f.keep(
    await f.exchange(await f.code(), { client_id: f.second }),
    400,
  );
  expect(((await response.json()) as { error: string }).error).toBe(
    "invalid_grant",
  );
}, 30_000);
test("the requested resource cannot change at token exchange", async () => {
  const f = await fixture();
  expect((await f.exchange(await f.code(), { resource: other })).status).toBe(
    400,
  );
}, 30_000);
test("callback requires its browser cookie", async () => {
  const f = await fixture();
  expect(
    (await f.api.callback(new Request((await f.upstream()).href))).status,
  ).toBe(400);
}, 30_000);
test("upstream identity expiry uses the injected clock", async () => {
  const f = await fixture(),
    url = await f.upstream();
  f.advance();
  expect((await f.api.callback(f.request(url.href))).status).toBe(400);
}, 30_000);

test("concurrent code exchanges allow exactly one redemption", async () => {
  const f = await fixture(),
    code = await f.code();
  const responses = await Promise.all([f.exchange(code), f.exchange(code)]);
  expect(responses.map((response) => response.status).sort()).toEqual([
    200, 400,
  ]);
  const refused = responses.find((response) => response.status === 400)!;
  const body = (await refused.json()) as {
    error: string;
    code?: string;
    access_token?: string;
  };
  expect(body.error).toBe("invalid_grant");
  expect(body.code).toBeUndefined();
  expect(body.access_token).toBeUndefined();
  expect(JSON.stringify(body)).not.toContain(code);
}, 30_000);

test("identity expires while its upstream transaction is still valid", async () => {
  const f = await fixture(1_000),
    url = await f.upstream();
  const identity = await f.options.upstream.verify(
    f.request(url.href),
    f.options.clock.now(),
  );
  expect(identity.ok).toBe(true);
  f.options.upstream.verify = () => Promise.resolve(identity);
  f.advance(2_000);
  const response = f.keep(await f.api.callback(f.request(url.href)), 400);
  expect(((await response.json()) as { error: string }).error).toBe(
    "access_denied",
  );
}, 30_000);

test("a failed verifier still burns the authorization code", async () => {
  const f = await fixture(),
    code = await f.code();
  f.keep(await f.exchange(code, { code_verifier: "wrong" }), 400);
  const response = f.keep(await f.exchange(code), 400);
  expect(((await response.json()) as { error: string }).error).toBe(
    "invalid_grant",
  );
}, 30_000);

test("JSON and multipart token requests do not burn a valid code", async () => {
  const f = await fixture(),
    code = await f.code(),
    multipart = new FormData();
  multipart.set("code", code);
  for (const body of [JSON.stringify({ code }), multipart]) {
    const response = await f.api.token(
      new Request(`${issuer}/oauth/token`, {
        method: "POST",
        body,
        ...(typeof body === "string"
          ? { headers: { "Content-Type": "application/json" } }
          : {}),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
  }
  expect((await f.exchange(code)).status).toBe(200);
}, 30_000);
