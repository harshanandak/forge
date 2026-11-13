import { expect, mock, spyOn, test } from "bun:test";
import { sha256 } from "../../../cloud/src/tokens.ts";
import { Database } from "bun:sqlite";
import { Project } from "../../../cloud/src/project.ts";
import {
  OAuthConfigError,
  readOAuthConfig,
} from "../../../cloud/src/adapters/workers-oauth/config.ts";
import { createOAuthHarness } from "../../adapters/workers-oauth/harness.ts";
import { jwtFixture } from "../../adapters/clerk/jwt-fixture.ts";
import { durableRedemption } from "../../../cloud/src/adapters/workers-oauth/redemption.ts";
if (!("timingSafeEqual" in crypto.subtle))
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    value: crypto.timingSafeEqual.bind(crypto),
  });
await mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
const { createConfiguredWorker } =
  await import("../../../cloud/src/adapters/workers-oauth/compose.ts");
const { composeAuth } = await import("../../../cloud/src/auth/compose.ts");
const issuer = "https://auth.example",
  redirect = "https://client.example/callback";
const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const vars = {
  CLERK_ISSUER: "https://clerk.example",
  CLERK_CLIENT_ID: "public-client",
  CLERK_REDIRECT_URI: `${issuer}/callback`,
  FORGE_API_RESOURCE: "https://api.example/a",
  OAUTH_TIMEOUT_MS: "5000",
};
const field = async (response: Response, key: string) =>
  ((await response.json()) as Record<string, string>)[key]!;
const status = async (response: Promise<Response>) => (await response).status;
const codeOf = (response: Response) =>
  new URL(response.headers.get("location")!).searchParams.get("code")!;
function sanitized(body: string, ...proofs: string[]) {
  for (const value of [
    ...Object.values(vars),
    verifier,
    "clerk-code",
    "private upstream",
    ...proofs,
  ])
    expect(body).not.toContain(value);
}
async function fixture(claims = {}, alg = "RS256") {
  const harness = createOAuthHarness();
  harness.advance(Date.now() - harness.options.clock.now());
  const now = Math.floor(harness.options.clock.now() / 1000);
  const { proof, jwk } = await jwtFixture(
    vars.CLERK_ISSUER,
    vars.CLERK_CLIENT_ID,
    {
      algorithm: alg,
      claims: {
        auth_time: now - 1,
        exp: now + 600,
        org_id: "untrusted-org",
        ...claims,
      },
    },
  );
  const cookies = new Map<string, string>();
  const transport = {
    idFromName: (name: string) => name,
    get: () => ({ fetch: () => Promise.resolve(new Response("legacy")) }),
  };
  const env = {
    ...vars,
    FORGE_OAUTH_REDIRECTS: redirect,
    ADMIN_TOKEN: "fixture-admin",
    PROJECTS: transport,
    REGISTRATION_LIMITER: transport,
    OAUTH_KV: harness.options.storage,
    GRANT_STATE: harness.grantNamespace,
    CODE_REDEMPTION: {
      idFromName: (hash: string) => hash,
      get: (hash: unknown) => ({
        fetch: async (request: Request) =>
          new Response(null, {
            status: (await harness.options.codeRedemption.claimOnce(
              String(hash),
              Number(new URL(request.url).searchParams.get("until")),
            ))
              ? 200
              : 400,
          }),
      }),
    },
  };
  let challenge = "",
    jwks = 0;
  const network = async (url: string, init?: RequestInit) => {
    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (url === `${vars.CLERK_ISSUER}/.well-known/jwks.json`) {
      jwks++;
      return Response.json({ keys: [jwk] });
    }
    expect(url).toBe(`${vars.CLERK_ISSUER}/oauth/token`);
    expect(init?.method).toBe("POST");
    const body = init?.body;
    if (!(body instanceof URLSearchParams))
      throw new Error("Expected form body");
    expect(body.get("client_id")).toBe(vars.CLERK_CLIENT_ID);
    expect(body.get("redirect_uri")).toBe(vars.CLERK_REDIRECT_URI);
    const digest = Buffer.from(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(body.get("code_verifier")!),
      ),
    ).toString("base64url");
    return digest === challenge
      ? Response.json({ id_token: proof })
      : new Response("private upstream", { status: 400 });
  };
  const forward = mock((_request: Request, _project: string, access: unknown) =>
    Promise.resolve(Response.json(access)),
  );
  const worker = createConfiguredWorker(undefined, {
    fetch: network,
    clock: harness.options.clock,
    policy: { authorize: () => ({ allowed: true }) },
    forward,
  });
  const send = async (path: string, form?: Record<string, string>) => {
    const response = await worker.fetch(
      new Request(new URL(path, issuer).href, {
        headers: { cookie: [...cookies.values()].join("; ") },
        ...(form ? { method: "POST", body: new URLSearchParams(form) } : {}),
      }),
      env,
    );
    for (const cookie of response.headers.getSetCookie())
      cookies.set(cookie.split("=")[0]!, cookie.split(";")[0]!);
    return response;
  };
  async function start() {
    const registered = await worker.fetch(
      new Request(`${issuer}/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "203.0.113.1",
        },
        body: JSON.stringify({
          redirect_uris: [redirect],
          token_endpoint_auth_method: "none",
          client_name: '<script>"',
        }),
      }),
      env,
    );
    expect(registered.status).toBe(201);
    const client = await field(registered, "client_id");
    const auth = await send(
      `/authorize?${new URLSearchParams({ response_type: "code", client_id: client, redirect_uri: redirect, resource: vars.FORGE_API_RESOURCE, state: "client-state", code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256" })}`,
    );
    expect(auth.status).toBe(200);
    expect(
      Object.fromEntries(
        [
          "content-type",
          "cache-control",
          "x-frame-options",
          "content-security-policy",
          "referrer-policy",
        ].map((key) => [key, auth.headers.get(key)]),
      ),
    ).toEqual({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
    });
    const page = await auth.text();
    expect(page).toContain("&lt;script&gt;&quot;");
    expect(page).not.toContain('<script>"');
    expect(page).toContain(redirect);
    expect(page).toContain('<form method="post" action="/authorize">');
    expect(page).toContain('value="true">Allow</button>');
    expect(page).toContain('value="false">Deny</button>');
    expect(auth.headers.getSetCookie().length).toBeGreaterThan(0);
    const handle = /name="handle" value="([^"]+)"/.exec(page)?.[1];
    expect(handle).toBeDefined();
    const login = await send("/authorize", {
      handle: handle!,
      allow: "true",
    });
    expect(login.status).toBe(302);
    const target = new URL(login.headers.get("location")!);
    expect(target.origin + target.pathname).toBe(
      `${vars.CLERK_ISSUER}/oauth/authorize`,
    );
    expect(target.searchParams.get("code_challenge_method")).toBe("S256");
    challenge = target.searchParams.get("code_challenge")!;
    const callback = `${vars.CLERK_REDIRECT_URI}?${new URLSearchParams({ state: target.searchParams.get("state")!, code: "clerk-code" })}`;
    return {
      callback,
      finish: () => send(callback),
      exchange: (code: string) =>
        send("/oauth/token", {
          grant_type: "authorization_code",
          client_id: client,
          redirect_uri: redirect,
          resource: vars.FORGE_API_RESOURCE,
          code,
          code_verifier: verifier,
        }),
    };
  }
  const jwksCount = () => jwks;
  const configured = createConfiguredWorker(undefined, {
    fetch: network,
    clock: harness.options.clock,
  });
  return {
    env,
    worker,
    configured,
    start,
    send,
    proof,
    forward,
    network,
    jwksCount,
  };
}

async function ownerFixture(claims = {}) {
  const f = await fixture({ sub: "user_owner", ...claims });
  const flow = await f.start();
  const token = await field(
    await flow.exchange(codeOf(await flow.finish())),
    "access_token",
  );
  const db = new Database(":memory:"),
    values = new Map<string, unknown>();
  const project = new Project({
    storage: {
      sql: {
        exec: (sql, ...bindings) => {
          const rows = db
            .query(sql)
            .all(
              ...bindings.map((value) =>
                value instanceof ArrayBuffer ? new Uint8Array(value) : value,
              ),
            ) as Record<string, unknown>[];
          return { toArray: () => rows };
        },
      },
      transactionSync: (body) => db.transaction(body)(),
      get: (key) => Promise.resolve(values.get(key)),
      put: (key, value) => {
        values.set(key, value);
        return Promise.resolve();
      },
      delete: (key) => Promise.resolve(values.delete(key)),
    },
  });
  const names: string[] = [];
  const env = {
    ...f.env,
    FORGE_OWNER_SUBJECT: "user_owner",
    PROJECTS: {
      idFromName: (name: string) => {
        names.push(name);
        return name;
      },
      get: () => project,
    },
  };
  const request = (
    route = "holder?subject=issue",
    credential = token,
    extra = {},
  ) =>
    new Request(`${issuer}/p/a/${route}`, {
      headers: {
        ...(credential ? { authorization: `Bearer ${credential}` } : {}),
        ...extra,
      },
    });
  const post = (route: string, body: unknown, credential = token) =>
    f.configured.fetch(
      new Request(request(route, credential), {
        method: "POST",
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      env,
    );
  return {
    ...f,
    env,
    token,
    request,
    names,
    post,
    db,
    values,
    close: () => db.close(),
  };
}

test("configured owner reaches the real project object without injected policy or forwarding", async () => {
  const f = await ownerFixture();
  try {
    const response = await f.configured.fetch(
      f.request(undefined, f.token, { "X-Forge-Owner": "user_attacker" }),
      f.env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, value: null });
    expect(f.names).toEqual(["a"]);
    expect(f.forward).toHaveBeenCalledTimes(0);
    const status = await f.configured.fetch(
      f.request("status", "fixture-admin"),
      f.env,
    );
    expect(await status.json()).toMatchObject({
      value: { initialized: false },
    });
    const holder = {
      actor: { kind: "agent", id: "owner-agent" },
      session: {
        id: "owner-session",
        device: `oauth-owner:${await sha256(JSON.stringify([vars.CLERK_ISSUER, "user_owner"]))}`,
      },
    };
    for (const route of ["claim", "renew", "release"]) {
      const written = await f.post(route, {
        subject: "issue",
        holder,
        requestId: route,
        ttlMs: 60_000,
        generation: 1,
      });
      expect(written.status).toBe(200);
      expect(await written.json()).toMatchObject({
        ok: true,
        value: { holder },
      });
    }
  } finally {
    f.close();
  }
}, 30_000);

test("owner matching requires both issuer and subject and keeps audience refusal", async () => {
  for (const [claims, overrides, expected] of [
    [{ sub: "user_attacker", org_id: "owner-org" }, {}, 403],
    [{}, { CLERK_ISSUER: "https://other-clerk.example" }, 403],
    [{}, { FORGE_OWNER_SUBJECT: undefined }, 403],
    [{}, { FORGE_API_RESOURCE: "https://api.example/b" }, 401],
  ] as const) {
    const f = await ownerFixture(claims);
    try {
      const response = await f.configured.fetch(
        f.request(undefined, f.token, { "X-Forge-Owner": "user_owner" }),
        { ...f.env, ...overrides },
      );
      expect(response.status).toBe(expected);
      expect(await response.json()).toMatchObject({
        error: { code: expected === 401 ? "AUTH_INVALID" : "AUTH_FORBIDDEN" },
      });
      expect(f.names).toEqual([]);
    } finally {
      f.close();
    }
  }
}, 30_000);

test("owner subject config is strict and refuses without echoing its value", async () => {
  for (const value of [
    "",
    "user_",
    "user_bad-id",
    " user_owner",
    "user_owner\n",
    123,
    null,
  ]) {
    expect(() =>
      readOAuthConfig({ ...vars, FORGE_OWNER_SUBJECT: value }, issuer),
    ).toThrow(OAuthConfigError);
    const f = await fixture();
    const response = await f.configured.fetch(
      new Request(`${issuer}/authorize`),
      { ...f.env, FORGE_OWNER_SUBJECT: value },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "AUTH_CONFIG_UNAVAILABLE",
        variable: "FORGE_OWNER_SUBJECT",
        message: "OAuth configuration unavailable",
      },
    });
  }
}, 30_000);

test("forged owner headers grant nothing and OAuth cannot reach any admin route", async () => {
  const f = await ownerFixture();
  try {
    for (const [credential, expected] of [
      ["", 401],
      ["forged", 401],
      [`fct_${"0".repeat(16)}.${"x".repeat(43)}`, 401],
    ] as const) {
      const response = await f.configured.fetch(
        f.request(undefined, credential, { "X-Forge-Owner": "user_owner" }),
        f.env,
      );
      expect(response.status).toBe(expected);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code: credential ? "AUTH_INVALID" : "AUTH_REQUIRED" },
      });
    }
    f.names.length = 0;
    for (const route of ["devices", "revoke", "status", "dump", "restore"]) {
      expect((await f.configured.fetch(f.request(route), f.env)).status).toBe(
        401,
      );
    }
    expect(f.names).toEqual([]);
    const admin = await f.configured.fetch(
      f.request("status", "fixture-admin"),
      f.env,
    );
    expect(admin.status).toBe(200);
    expect(await admin.json()).toEqual({
      ok: true,
      value: { initialized: false },
    });
  } finally {
    f.close();
  }
}, 30_000);

test("device issuance and project reads still require the issued device token", async () => {
  const f = await ownerFixture();
  const clock = spyOn(Date, "now").mockReturnValue(Date.now());
  try {
    const issued = await f.post(
      "devices",
      { device: "laptop", ttlMs: 60_000 },
      "fixture-admin",
    );
    expect(issued.status).toBe(200);
    const body = (await issued.json()) as { value: { token: string } };
    const response = await f.configured.fetch(
      f.request(undefined, body.value.token),
      f.env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, value: null });
    const holder = {
      actor: { kind: "agent", id: "device-agent" },
      session: { id: "device-session", device: "laptop" },
    };
    const input = {
      subject: "issue",
      holder,
      requestId: "device-claim",
      ttlMs: 60_000,
      generation: 1,
    };
    expect((await f.post("claim", input, body.value.token)).status).toBe(200);
    for (const route of ["renew", "release"]) {
      const denied = await f.post(route, { ...input, requestId: route });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({
        error: { code: "AUTH_DEVICE_MISMATCH" },
      });
    }
  } finally {
    clock.mockRestore();
    f.close();
  }
}, 30_000);

for (const version of [1, 2])
  test(`rejected owner writes preserve provisioning and a version ${version} paged admin restore`, async () => {
    const f = await ownerFixture();
    try {
      expect((await f.post("claim", "{")).status).toBe(400);
      expect(f.values.get("provisioned")).toBeUndefined();
      const dumped = await f.configured.fetch(
        f.request("dump", "fixture-admin"),
        f.env,
      );
      const {
        value: { tables },
      } = (await dumped.json()) as {
        value: { tables: Record<string, unknown[]> };
      };
      if (version === 1) delete tables.domain_cloud_command_receipts;
      tables.state_records = [
        { namespace: "n", key: "staged", revision: 1, body: "{}" },
      ];
      const page = {
        format: `forge-cloud-dump-page/${version}`,
        page: 0,
        last: false,
        next: "more",
        tables,
      };
      expect((await f.post("restore", page, "fixture-admin")).status).toBe(200);
      const staged = f.db.query("SELECT * FROM state_records").all();
      for (const body of ["{", { subject: "issue" }]) {
        expect((await f.post("claim", body)).status).toBe(409);
        expect(f.values.get("provisioned")).toBeUndefined();
        expect(f.values.get("restore:next")).toBe(1);
        expect(f.db.query("SELECT * FROM state_records").all()).toEqual(staged);
      }
      tables.state_records = [];
      expect(
        (await f.post("restore", { ...page, page: 1 }, "fixture-admin")).status,
      ).toBe(200);
    } finally {
      f.close();
    }
  }, 30_000);

test("owner writes recheck credential expiry after the body finishes streaming", async () => {
  const expiresAt = Math.floor(Date.now() / 1000) * 1000 + 60_000;
  const f = await ownerFixture({ exp: expiresAt / 1000 });
  const now = spyOn(Date, "now");
  try {
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          now.mockReturnValue(expiresAt + 1);
          controller.enqueue(
            new TextEncoder().encode(
              '{"subject":"issue","holder":{"actor":{"kind":"agent","id":"owner"},"session":{"id":"owner-session"}},"ttlMs":60000,"requestId":"expired"}',
            ),
          );
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const response = await f.configured.fetch(
      new Request(
        f.request("claim", f.token, {
          "X-Forge-Owner-Expires": String(expiresAt + 60_000),
        }),
        { method: "POST", body },
      ),
      f.env,
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "AUTH_EXPIRED" },
    });
    expect(
      f.db
        .query("SELECT name FROM sqlite_master WHERE name='state_leases'")
        .all(),
    ).toEqual([]);
  } finally {
    now.mockRestore();
    f.close();
  }
}, 30_000);
async function refused(
  response: Response,
  proof: string,
  error = "access_denied",
) {
  expect(response.status).toBe(400);
  const body = await response.text();
  expect(JSON.parse(body)).toEqual({ error });
  sanitized(body, proof);
}

test("configured login uses cached JWKS and verified project authorization", async () => {
  const f = await fixture(),
    a = await f.start(),
    callback = await a.finish();
  expect(callback.status).toBe(302);
  const issued = await a.exchange(codeOf(callback));
  expect(issued.status).toBe(200);
  const project = new Request(`${issuer}/p/a/holder`, {
    headers: { authorization: `Bearer ${await field(issued, "access_token")}` },
  });
  expect(await status(f.worker.fetch(project, f.env))).toBe(200);
  expect(f.forward).toHaveBeenCalledTimes(1);
  const defaultPolicy = createConfiguredWorker(undefined, { fetch: f.network });
  expect(await status(defaultPolicy.fetch(project, f.env))).toBe(403);
  const b = await f.start();
  expect((await b.finish()).status).toBe(302);
  expect(f.jwksCount()).toBe(1);
}, 30_000);

test("configured token exchange permits one success and refuses races and replay", async () => {
  const f = await fixture(),
    a = await f.start(),
    callback = await a.finish();
  expect(callback.status).toBe(302);
  const code = codeOf(callback);
  expect((await a.exchange(code)).status).toBe(200);
  const replay = await a.exchange(code);
  expect(replay.status).toBe(400);
  sanitized(await replay.text(), code);
  const b = await f.start(),
    second = await b.finish();
  expect(second.status).toBe(302);
  const next = codeOf(second),
    results = await Promise.all([b.exchange(next), b.exchange(next)]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
}, 30_000);

test("configured callbacks refuse replay, foreign state and invalid ID tokens", async () => {
  for (const [claims, alg] of [
    [{ aud: "other" }, "RS256"],
    [{ iss: "https://lookalike.example" }, "RS256"],
    [{ exp: 0 }, "RS256"],
    [{}, "HS256"],
  ] as const) {
    const f = await fixture(claims, alg),
      flow = await f.start();
    await refused(await flow.finish(), f.proof);
  }
  const a = await fixture(),
    b = await fixture(),
    first = await a.start(),
    second = await b.start();
  await refused(await a.send(second.callback), a.proof, "invalid_request");
  expect((await first.finish()).status).toBe(302);
  await refused(await first.finish(), a.proof, "invalid_request");
}, 30_000);

test("missing redemption refuses while device/admin and unmarked composition remain safe", async () => {
  const f = await fixture();
  const bindings = [undefined, {}, { idFromName: "invalid", get: () => ({}) }];
  for (const [variable, binding] of ["CODE_REDEMPTION", "GRANT_STATE"].flatMap(
    (variable) => bindings.map((binding) => [variable, binding] as const),
  )) {
    const env = { ...f.env, [variable]: binding };
    const response = await f.worker.fetch(
      new Request(`${issuer}/oauth/token`),
      env,
    );
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({
      error: { code: "AUTH_CONFIG_UNAVAILABLE", variable },
    });
    sanitized(body);
    for (const [path, token] of [
      ["status", "fixture-admin"],
      ["holder", `fct_${"0".repeat(16)}.${"x".repeat(43)}`],
    ]) {
      const request = new Request(`${issuer}/p/a/${path}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(await status(f.worker.fetch(request, env))).toBe(200);
    }
  }
  const route = mock(() => Promise.resolve(new Response("unsafe")));
  const auth = composeAuth(
    { verify: () => Promise.resolve(null) },
    vars.FORGE_API_RESOURCE,
    undefined,
    undefined,
    route,
  );
  expect((await auth.route(new Request(`${issuer}/callback`))).status).toBe(
    503,
  );
  expect(route).toHaveBeenCalledTimes(0);
  for (const [port, expected] of [
    [{ claimOnce: () => Promise.resolve(true) }, 503],
    [durableRedemption(f.env.CODE_REDEMPTION), 200],
  ] as const) {
    const marked = composeAuth(
      undefined,
      vars.FORGE_API_RESOURCE,
      undefined,
      undefined,
      route,
      port,
    );
    for (const path of ["/callback", "/oauth/token"])
      expect((await marked.route(new Request(`${issuer}${path}`))).status).toBe(
        expected,
      );
  }
}, 30_000);

test("malformed consent bodies return sanitized invalid_request", async () => {
  const f = await fixture();
  for (const type of [
    "application/json",
    "multipart/form-data; boundary=broken",
  ]) {
    const response = await f.worker.fetch(
      new Request(`${issuer}/authorize`, {
        method: "POST",
        headers: { "Content-Type": type },
        body: "clerk-code",
      }),
      f.env,
    );
    await refused(response, f.proof, "invalid_request");
  }
}, 30_000);

test("configured metadata uses the configured issuer despite a mismatched Host", async () => {
  const f = await fixture();
  for (const path of [
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-protected-resource",
  ]) {
    const response = await f.worker.fetch(
      new Request(`${issuer}${path}`, {
        headers: { Host: "lookalike.example" },
      }),
      f.env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject(
      path.endsWith("protected-resource")
        ? { authorization_servers: [issuer] }
        : { issuer },
    );
  }
}, 30_000);
