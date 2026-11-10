import { singleOwnerPolicy } from "../../../src/ports/authorization.ts";
import { expect, mock, test } from "bun:test";
import {
  isVerifiedIdentity,
  type VerifiedIdentity,
} from "../../../src/ports/identity.ts";
import { testIdentityVerifier } from "../../contract/lib/identity-verifier.ts";
import { createOAuthHarness } from "../../adapters/workers-oauth/harness.ts";

// Bridge the Worker extension to the test runtime's native comparator.
if (!("timingSafeEqual" in crypto.subtle))
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    value: crypto.timingSafeEqual.bind(crypto),
  });

await mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
const { createOAuthAdapter } =
  await import("../../../cloud/src/adapters/workers-oauth/index.ts");
const { createWorker } = await import("../../../cloud/src/worker.ts");
const { composeOAuth, createConfiguredWorker } =
  await import("../../../cloud/src/adapters/workers-oauth/compose.ts");
const { readOAuthConfig } =
  await import("../../../cloud/src/adapters/workers-oauth/config.ts");
const issuer = "https://auth.example",
  resource = "https://api.example/a";
const claims = {
  issuer: "https://identity.example",
  subject: "person",
  audience: issuer,
  authenticatedAt: 1_000_000,
  expiresAt: 4_600_000,
};

async function fixture(denied = false, expectedResource = resource) {
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

  const protocol = mock((request: Request) =>
    Promise.resolve(Response.json({ path: new URL(request.url).pathname })),
  );
  const auth = composeOAuth(
    harness.options,
    expectedResource,
    {
      authorize: () =>
        denied ? { allowed: false, code: "AUTH_FORBIDDEN" } : { allowed: true },
    },
    undefined,
    protocol,
  );
  const env = {
    ADMIN_TOKEN: "fixture-admin",
    PROJECTS: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: () => Promise.resolve(new Response("legacy")) }),
    },
  };
  const forward = mock((_request: Request, project: string, access: unknown) =>
    Promise.resolve(Response.json({ project, ...(access as object) })),
  );
  return {
    ...harness,
    api,
    callback,
    token,
    auth,
    env,
    forward,
    worker: createWorker(auth, forward),
  };
}

test("a provider token carries the verifier's exact issuer and subject", async () => {
  const f = await fixture(),
    token = await f.token();
  const identity = await f.api.verify(token, resource);
  expect(isVerifiedIdentity(identity)).toBe(true);
  expect(identity).toMatchObject({ ...claims, audience: resource });
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

test("the verified upstream audience is distinct from the authorization server and resource", async () => {
  for (const verifiedAudience of ["upstream-client", "wrong-client"]) {
    const f = await fixture();
    const verifier = testIdentityVerifier(
      new Map([["proof", { ...claims, audience: "upstream-client" }]]),
    );
    f.options.upstream.verify = async (_request, now) => ({
      ...(await verifier.verify("proof", "upstream-client", now)),
      verifiedAudience,
    });
    if (verifiedAudience === "upstream-client")
      expect(await f.api.verify(await f.token(), resource)).toMatchObject({
        ...claims,
        audience: resource,
      });
    else expect((await f.callback()).status).toBe(400);
  }
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

const oauthPaths = [
  "/authorize",
  "/callback",
  "/oauth/token",
  "/register",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource",
];
const projectRequest = (token: string, path = "/p/a/holder?subject=attacker") =>
  new Request(`${issuer}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      "x-forwarded-user": "attacker",
      "x-identity-subject": "attacker",
    },
  });

test("Worker and MCP receive the same verified identity and allow decision", async () => {
  const f = await fixture(),
    request = projectRequest(await f.token());
  const response = await f.worker.fetch(request, f.env);
  expect(response.status).toBe(200);
  const access = await f.auth.mcp(request, "a", "holder");
  expect(await response.json()).toEqual({ project: "a", ...access });
  expect<unknown>(access.principal).toEqual({
    kind: "person",
    identity: { ...claims, audience: resource },
  });
  expect(access.decision).toEqual({ allowed: true });
  expect(f.forward).toHaveBeenCalledTimes(1);
  expect((await f.auth.mcp(request, "a", "holder", "team")).decision).toEqual({
    allowed: false,
    code: "TEAM_AUTHORIZATION_UNAVAILABLE",
  });

  for (const denied of [false, true]) {
    const f = await fixture(
      denied,
      denied ? resource : "https://api.example/b",
    );
    expect(
      (await f.worker.fetch(projectRequest(await f.token()), f.env)).status,
    ).toBe(denied ? 403 : 401);
    expect(f.forward).toHaveBeenCalledTimes(0);
  }
}, 30_000);
const deviceToken = `fct_${"0".repeat(16)}.${"x".repeat(43)}`;
test("legacy devices never reach trusted transport and fetch rejections are sanitized", async () => {
  const f = await fixture();
  for (const code of ["AUTH_INVALID", "AUTH_REVOKED", "AUTH_EXPIRED"]) {
    const device = mock(() =>
      Promise.resolve(Response.json({ error: { code } }, { status: 401 })),
    );
    f.env.PROJECTS.get = () => ({ fetch: device });
    const response = await f.worker.fetch(projectRequest(deviceToken), f.env);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code } });
    expect(device).toHaveBeenCalledTimes(1);
    expect(f.forward).toHaveBeenCalledTimes(0);
  }
  const token = await f.token(),
    message = "private transport detail";
  const reject = () => Promise.reject(new Error(message));
  const worker = createWorker(f.auth, reject);
  f.env.PROJECTS.get = () => ({ fetch: reject });
  for (const presented of [token, deviceToken]) {
    const response = await worker.fetch(projectRequest(presented), f.env);
    expect(response.status).toBe(401);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({
      error: { code: "AUTH_INVALID", message: "Token is not valid" },
    });
    expect(body).not.toContain(message);
  }
}, 30_000);

test("missing OAuth composition refuses OAuth routes and preserves device and admin routing", async () => {
  const f = await fixture(),
    worker = createWorker();
  for (const path of oauthPaths) {
    const response = await worker.fetch(projectRequest("", path), f.env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "AUTH_CONFIG_UNAVAILABLE" },
    });
  }
  for (const [route, token] of [
    ["holder", `fct_${"0".repeat(16)}.${"x".repeat(43)}`],
    ["status", "fixture-admin"],
  ])
    expect(
      (await worker.fetch(projectRequest(token!, `/p/a/${route}`), f.env))
        .status,
    ).toBe(200);

  for (const path of oauthPaths) {
    const response = await f.worker.fetch(projectRequest("", path), f.env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ path });
  }
  expect(f.forward).toHaveBeenCalledTimes(0);
}, 30_000);
const vars = {
  CLERK_ISSUER: "https://clerk.example",
  CLERK_CLIENT_ID: "public-client",
  CLERK_REDIRECT_URI: `${issuer}/callback`,
  FORGE_API_RESOURCE: resource,
  OAUTH_TIMEOUT_MS: "5000",
};

test("Worker vars derive Clerk endpoints without secrets", () => {
  expect(readOAuthConfig(vars, issuer)).toEqual({
    issuer: vars.CLERK_ISSUER,
    authorizationUrl: "https://clerk.example/oauth/authorize",
    tokenUrl: "https://clerk.example/oauth/token",
    jwksUrl: "https://clerk.example/.well-known/jwks.json",
    clientId: vars.CLERK_CLIENT_ID,
    redirectUri: vars.CLERK_REDIRECT_URI,
    resource,
    timeoutMs: 5000,
  });
}, 30_000);

test("missing and invalid vars refuse every OAuth route without breaking device or admin", async () => {
  const f = await fixture(),
    worker = createConfiguredWorker();
  const invalid = {
    CLERK_ISSUER: [
      "http://clerk.example",
      "https://user:pass@clerk.example",
      "https://clerk.example/path",
      "https://clerk.example/../",
      "https://clerk.example?x=1",
      "https://clerk.example#x",
    ],
    CLERK_CLIENT_ID: ["", " ", "bad\nclient"],
    CLERK_REDIRECT_URI: [
      "https://other.example/callback",
      `${issuer}/elsewhere`,
      `${issuer}/callback?code=x`,
      `${issuer}/callback#x`,
      "http://auth.example/callback",
    ],
    FORGE_API_RESOURCE: [
      "",
      "http://api.example/a",
      "https://user:pass@api.example/a",
      "https://api.example/a#x",
    ],
    OAUTH_TIMEOUT_MS: ["0", "-1", "1.5", "NaN", "2147483648"],
    OAUTH_KV: [null],
  };
  for (const [variable, values] of Object.entries(invalid)) {
    for (const value of [undefined, ...values]) {
      const env = {
        ...f.env,
        ...vars,
        OAUTH_KV: f.options.storage,
        [variable]: value,
      };
      for (const path of oauthPaths) {
        const response = await worker.fetch(projectRequest("", path), env);
        expect(response.status).toBe(503);
        const body = await response.text();
        expect(JSON.parse(body)).toMatchObject({
          error: { code: "AUTH_CONFIG_UNAVAILABLE", variable },
        });
        if (typeof value === "string" && value.length > 1)
          expect(body).not.toContain(value);
      }
      for (const [path, token] of [
        ["holder", deviceToken],
        ["status", "fixture-admin"],
      ])
        expect(
          (await worker.fetch(projectRequest(token!, `/p/a/${path}`), env))
            .status,
        ).toBe(200);
    }
  }
}, 30_000);

test("configured OAuth dispatch uses the protocol handler without project forwarding", async () => {
  const f = await fixture();
  const protocol = mock((request: Request) =>
    Promise.resolve(Response.json({ path: new URL(request.url).pathname })),
  );
  const worker = createConfiguredWorker(protocol),
    env = { ...f.env, ...vars, OAUTH_KV: f.options.storage };
  for (const path of oauthPaths.filter(
    (path) => path !== "/callback" && path !== "/oauth/token",
  )) {
    const response = await worker.fetch(projectRequest("", path), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ path });
  }
  expect(protocol).toHaveBeenCalledTimes(4);
}, 30_000);

test("token and callback refuse without atomic redemption even with every var set", async () => {
  const f = await fixture();
  const protocol = mock(() => Promise.resolve(new Response("unexpected")));
  for (const worker of [
    createConfiguredWorker(),
    createConfiguredWorker(protocol),
  ]) {
    const env = { ...f.env, ...vars, OAUTH_KV: f.options.storage };
    for (const path of ["/oauth/token", "/callback"]) {
      const response = await worker.fetch(projectRequest("", path), env);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: {
          code: "AUTH_CONFIG_UNAVAILABLE",
          variable: "CODE_REDEMPTION",
          message: "Atomic redemption unavailable",
        },
      });
    }
  }
  expect(protocol).toHaveBeenCalledTimes(0);
}, 30_000);
