import { expect, mock, test } from "bun:test";
import { createOAuthHarness } from "../../adapters/workers-oauth/harness.ts";

if (!("timingSafeEqual" in crypto.subtle))
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    value: crypto.timingSafeEqual.bind(crypto),
  });
await mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
const { createConfiguredWorker } =
  await import("../../../cloud/src/adapters/workers-oauth/compose.ts");
const issuer = "https://auth.example",
  resource = "https://api.example/a",
  named = "https://app.example/cb";
const baseVars = {
  CLERK_ISSUER: "https://clerk.example",
  CLERK_CLIENT_ID: "public-client",
  CLERK_REDIRECT_URI: `${issuer}/callback`,
  FORGE_API_RESOURCE: resource,
  OAUTH_TIMEOUT_MS: "5000",
};
const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

function fixture(extra: Record<string, unknown> = {}) {
  const harness = createOAuthHarness();
  harness.advance(Date.now() - harness.options.clock.now());
  const seen = { counted: 0 };
  const idle = {
    idFromName: (name: string) => name,
    get: () => ({ fetch: () => Promise.resolve(new Response()) }),
  };
  const env = {
    ...baseVars,
    ...extra,
    PROJECTS: idle,
    CODE_REDEMPTION: idle,
    REGISTRATION_LIMITER: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: () => {
          seen.counted++;
          return Promise.resolve(new Response());
        },
      }),
    },
    OAUTH_KV: harness.options.storage,
  };
  const worker = createConfiguredWorker(undefined, {
    clock: harness.options.clock,
    policy: { authorize: () => ({ allowed: true }) },
  });
  const register = (redirects?: unknown) =>
    worker.fetch(
      new Request(`${issuer}/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "203.0.113.7",
        },
        body: JSON.stringify({
          token_endpoint_auth_method: "none",
          client_name: "app",
          ...(redirects === undefined ? {} : { redirect_uris: redirects }),
        }),
      }),
      env,
    );
  const authorize = (client: string, redirect: string) =>
    worker.fetch(
      new Request(
        `${issuer}/authorize?${new URLSearchParams({ response_type: "code", client_id: client, redirect_uri: redirect, resource, state: "client-state", code_challenge: challenge, code_challenge_method: "S256" })}`,
      ),
      env,
    );
  return { register, authorize, seen, worker, env };
}
async function refused(response: Response) {
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: { code: "REGISTRATION_INVALID", field: "redirect_uris" },
  });
}
const page = (redirect: string, handle: string, loopback: boolean) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><title>Authorize access</title><h1>Authorize app</h1><p>Redirect: <code>${redirect}</code></p>${loopback ? "<p>This app runs on this computer.</p>" : ""}<form method="post" action="/authorize"><input type="hidden" name="handle" value="${handle}"><button name="allow" value="true">Allow</button><button name="allow" value="false">Deny</button></form></html>`;

test("loopback and named redirects register and count against the limiter", async () => {
  for (const [uri, vars] of [
    ["http://127.0.0.1:53682/callback", {}],
    ["http://[::1]:8080/cb", {}],
    ["http://localhost:9000/", {}],
    ["http://localhost/a/b?x=1", {}],
    [named, { FORGE_OAUTH_REDIRECTS: named }],
    [
      "https://second.example/cb",
      { FORGE_OAUTH_REDIRECTS: `${named}, https://second.example/cb` },
    ],
  ] as const) {
    const f = fixture(vars),
      response = await f.register([uri]);
    expect(response.status, uri).toBe(201);
    expect(
      ((await response.json()) as { redirect_uris: string[] }).redirect_uris,
    ).toEqual([uri]);
    expect(f.seen.counted).toBe(1);
  }
  const f = fixture({ FORGE_OAUTH_REDIRECTS: named });
  expect((await f.register(["http://127.0.0.1/cb", named])).status).toBe(201);
}, 30_000);

test("an address that is neither loopback nor named is refused before the limiter counts it", async () => {
  for (const vars of [
    {},
    { FORGE_OAUTH_REDIRECTS: "" },
    { FORGE_OAUTH_REDIRECTS: named },
  ]) {
    const f = fixture(vars);
    await refused(await f.register(["https://client.example/callback"]));
    expect(f.seen.counted).toBe(0);
  }
}, 30_000);

test("lookalike and malformed redirects are refused", async () => {
  for (const uri of [
    "http://127.0.0.1.attacker.example/",
    "http://localhost.attacker.example/",
    "http://127.0.0.1@attacker.example/",
    "http://localhost@attacker.example/",
    "https://127.0.0.1/cb",
    "https://localhost/cb",
    "HTTP://evil.example/",
    "http://localhost./cb",
    "http://localhost:abc/",
    "http://user:pass@localhost/cb",
    "http://localhost/cb#frag",
    "ftp://localhost/cb",
    "javascript:alert(1)",
    "app.example/cb",
    "https://app.example/cb?x=1",
    "https://app.example/other",
    "http://app.example/cb",
  ]) {
    const f = fixture({ FORGE_OAUTH_REDIRECTS: named });
    await refused(await f.register([uri]));
    expect(f.seen.counted, uri).toBe(0);
  }
}, 30_000);

test("one bad address in a list refuses the whole registration", async () => {
  for (const list of [
    ["http://127.0.0.1:53682/callback", "https://client.example/callback"],
    ["https://client.example/callback", "http://127.0.0.1:53682/callback"],
  ]) {
    const f = fixture();
    await refused(await f.register(list));
    expect(f.seen.counted).toBe(0);
  }
}, 30_000);

test("missing, empty and mistyped redirect_uris are refused", async () => {
  for (const value of [undefined, [], "http://127.0.0.1/cb", [5], null]) {
    const f = fixture();
    await refused(await f.register(value));
    expect(f.seen.counted).toBe(0);
  }
}, 30_000);

test("an invalid FORGE_OAUTH_REDIRECTS entry makes OAuth unavailable", async () => {
  for (const value of [
    "http://app.example/cb",
    "https://user:pass@app.example/cb",
    "https://app.example/cb?x=1",
    "https://app.example/cb#x",
    `${named},http://evil.example/`,
    `${named},,https://b.example/cb`,
    "not a url",
  ]) {
    const f = fixture({ FORGE_OAUTH_REDIRECTS: value });
    for (const response of [
      await f.register(["http://127.0.0.1/cb"]),
      await f.worker.fetch(new Request(`${issuer}/authorize`), f.env),
    ]) {
      expect(response.status, value).toBe(503);
      expect(await response.json()).toMatchObject({
        error: {
          code: "AUTH_CONFIG_UNAVAILABLE",
          variable: "FORGE_OAUTH_REDIRECTS",
        },
      });
    }
    expect(f.seen.counted).toBe(0);
  }
}, 30_000);

test("the consent page says a loopback app runs on this computer and is otherwise unchanged", async () => {
  const loopback = "http://127.0.0.1:53682/callback";
  for (const [uri, vars, expectLine] of [
    [loopback, {}, true],
    [named, { FORGE_OAUTH_REDIRECTS: named }, false],
  ] as const) {
    const f = fixture(vars),
      registered = await f.register([uri]);
    expect(registered.status).toBe(201);
    const client = ((await registered.json()) as { client_id: string })
      .client_id;
    const response = await f.authorize(client, uri);
    expect(response.status).toBe(200);
    const html = await response.text();
    const handle = html.split('name="handle" value="')[1]?.split('"')[0];
    expect(handle).toBeDefined();
    expect(html).toBe(page(uri, handle!, expectLine));
  }
}, 30_000);

test("a loopback client may differ from its registered redirect only in port", async () => {
  const f = fixture(),
    registered = await f.register(["http://127.0.0.1:53682/callback"]);
  expect(registered.status).toBe(201);
  const client = ((await registered.json()) as { client_id: string }).client_id;
  expect(
    (await f.authorize(client, "http://127.0.0.1:9999/callback")).status,
  ).toBe(200);
  for (const other of [
    "http://127.0.0.1:9999/other",
    "http://localhost:53682/callback",
    "https://attacker.example/callback",
  ])
    expect((await f.authorize(client, other)).status, other).toBe(400);
}, 30_000);

test("authorize refuses a redirect that differs from the registered one", async () => {
  const f = fixture({ FORGE_OAUTH_REDIRECTS: named }),
    registered = await f.register([named]);
  expect(registered.status).toBe(201);
  const client = ((await registered.json()) as { client_id: string }).client_id;
  for (const other of [
    "https://attacker.example/cb",
    "https://app.example/cb?x=1",
    "http://127.0.0.1:53682/callback",
  ])
    expect((await f.authorize(client, other)).status, other).toBe(400);
}, 30_000);
