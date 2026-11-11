import { expect, mock, test } from "bun:test";
import type { RegistrationStore } from "../../../cloud/src/adapters/workers-oauth/registration.ts";
import { createOAuthHarness } from "../../adapters/workers-oauth/harness.ts";

await mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
const { RegistrationLimiter, REGISTRATION_LIMITS: limits } =
  await import("../../../cloud/src/adapters/workers-oauth/registration.ts");
const { createConfiguredWorker } =
  await import("../../../cloud/src/adapters/workers-oauth/compose.ts");
const issuer = "https://auth.example",
  resource = "https://api.example/a",
  loopback = "http://127.0.0.1:53682/callback",
  named = "https://app.example/cb";

function fixture(vars: Record<string, unknown> = {}) {
  const counters = new Map<string, unknown>();
  let tail = Promise.resolve();
  const store: RegistrationStore = {
    get: <T>(key: string) =>
      Promise.resolve(counters.get(key) as T | undefined),
    put: (key, value) => {
      counters.set(key, value);
      return Promise.resolve();
    },
  };
  const limiter = new RegistrationLimiter(
    {
      storage: {
        ...store,
        transaction<T>(run: (store: RegistrationStore) => Promise<T>) {
          const result = tail.then(() => run(store));
          tail = result.then(
            () => undefined,
            () => undefined,
          );
          return result;
        },
      },
    },
    undefined,
    { now: () => limits.windowMs },
  );
  const harness = createOAuthHarness(),
    worker = createConfiguredWorker(undefined, {
      clock: harness.options.clock,
    });
  const env = {
    CLERK_ISSUER: "https://clerk.example",
    CLERK_CLIENT_ID: "public-client",
    CLERK_REDIRECT_URI: `${issuer}/callback`,
    FORGE_API_RESOURCE: resource,
    OAUTH_TIMEOUT_MS: "5000",
    PROJECTS: {
      idFromName: () => "",
      get: () => ({ fetch: () => Promise.resolve(new Response()) }),
    },
    REGISTRATION_LIMITER: {
      idFromName: (name: string) => name,
      get: () => limiter,
    },
    CODE_REDEMPTION: { idFromName: () => "", get: () => limiter },
    OAUTH_KV: harness.options.storage,
    ...vars,
  };
  const send = (path: string, body?: unknown) =>
    worker.fetch(
      new Request(`${issuer}${path}`, {
        ...(body === undefined
          ? {}
          : { method: "POST", body: JSON.stringify(body) }),
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "203.0.113.7",
        },
      }),
      env,
    );
  const register = (redirects: unknown) =>
    send("/register", {
      ...(redirects === undefined ? {} : { redirect_uris: redirects }),
      token_endpoint_auth_method: "none",
    });
  const authorize = (client: string, redirect: string) =>
    send(
      `/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: client,
        redirect_uri: redirect,
        resource,
        state: "client-state",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
      })}`,
    );
  return { counters, register, authorize, send };
}

async function registered(f: ReturnType<typeof fixture>, redirect: string) {
  const response = await f.register([redirect]);
  expect(response.status).toBe(201);
  const client = (await response.json()) as { client_id: string };
  expect(typeof client.client_id).toBe("string");
  return client.client_id;
}

async function invalid(f: ReturnType<typeof fixture>, redirects: unknown) {
  const response = await f.register(redirects);
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: { code: "REGISTRATION_INVALID", field: "redirect_uris" },
  });
  expect(f.counters.size).toBe(0);
}

for (const redirect of [
  loopback,
  "http://[::1]:8080/cb",
  "http://localhost:9000/",
])
  test(`registration admits loopback ${redirect} and counts its quota`, async () => {
    const f = fixture();
    await registered(f, redirect);
    expect(f.counters.get("window")).toMatchObject({ total: 1 });
  }, 30_000);

test("registration admits only the normalized named URLs from a comma-separated list", async () => {
  const f = fixture({
    FORGE_OAUTH_REDIRECTS:
      "https://other.example/cb,https://APP.example:443/a/../cb",
  });
  await registered(f, named);
  await registered(f, "https://other.example/cb");
  expect(f.counters.get("window")).toMatchObject({ total: 2 });
}, 30_000);

for (const value of [undefined, ""])
  test(`registration refuses unnamed redirects with ${String(value)} config before counting`, async () => {
    await invalid(fixture({ FORGE_OAUTH_REDIRECTS: value }), [
      "https://client.example/callback",
    ]);
  }, 30_000);

for (const redirect of [
  "http://127.0.0.1.attacker.example/",
  "http://localhost.attacker.example/",
  "http://127.0.0.1@attacker.example/",
  "https://127.0.0.1/cb",
  "HTTP://evil.example/",
  "http://localhost./cb",
  "http://[::2]/cb",
  "http://[::ffff:127.0.0.1]/cb",
  "http://%6cocalhost.attacker.example/cb",
  "http://user@localhost/cb",
  "http://localhost/cb#fragment",
  "http://localhost/cb#",
])
  test(`registration refuses lookalike or unsafe redirect ${redirect}`, async () => {
    await invalid(fixture(), [redirect]);
  }, 30_000);

test("a mixed redirect list is refused before consuming any quota", async () => {
  await invalid(fixture(), [loopback, "https://client.example/callback"]);
}, 30_000);

for (const redirects of [undefined, [], null, "http://localhost/cb", [123]])
  test(`registration requires a nonempty URI array: ${JSON.stringify(redirects)}`, async () => {
    await invalid(fixture(), redirects);
  }, 30_000);

for (const redirect of [
  `${named}/extra`,
  `${named}?x=1`,
  `${named}#fragment`,
  "https://app.example/other",
])
  test(`named registration requires the entire normalized URL: ${redirect}`, async () => {
    await invalid(fixture({ FORGE_OAUTH_REDIRECTS: named }), [redirect]);
  }, 30_000);

for (const value of [
  "http://app.example/cb",
  "https://user:pass@app.example/cb",
  `${named}?x=1`,
  `${named}#fragment`,
  `${named},not-a-url`,
  `${named},`,
  123,
  null,
])
  test(`invalid named redirect config fails closed: ${JSON.stringify(value)}`, async () => {
    const f = fixture({ FORGE_OAUTH_REDIRECTS: value });
    for (const path of [
      "/register",
      "/authorize",
      "/callback",
      "/oauth/token",
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource",
    ]) {
      const response = await f.send(path);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: {
          code: "AUTH_CONFIG_UNAVAILABLE",
          variable: "FORGE_OAUTH_REDIRECTS",
          message: "OAuth configuration unavailable",
        },
      });
    }
    expect(f.counters.size).toBe(0);
  }, 30_000);

for (const redirect of [loopback, named])
  test(`consent preserves the page and explains only loopback: ${redirect}`, async () => {
    const f = fixture({ FORGE_OAUTH_REDIRECTS: named }),
      client = await registered(f, redirect),
      response = await f.authorize(client, redirect);
    expect(response.status).toBe(200);
    const page = await response.text(),
      handle = /name="handle" value="([^"]+)"/.exec(page)?.[1],
      notice = "<p>This app runs on this computer.</p>";
    expect(handle).toBeDefined();
    expect(page).toContain(redirect);
    if (redirect === loopback) expect(page).toContain(notice);
    else expect(page).not.toContain(notice);
    expect(page.replace(notice, "")).toBe(
      `<!doctype html><html lang="en"><meta charset="utf-8"><title>Authorize access</title><h1>Authorize ${client}</h1><p>Redirect: <code>${redirect}</code></p><form method="post" action="/authorize"><input type="hidden" name="handle" value="${handle}"><button name="allow" value="true">Allow</button><button name="allow" value="false">Deny</button></form></html>`,
    );
  }, 30_000);

test("authorize allows a loopback port change but refuses a path change", async () => {
  const f = fixture(),
    client = await registered(f, loopback);
  expect(
    (await f.authorize(client, "http://127.0.0.1:9999/callback")).status,
  ).toBe(200);
  const refused = await f.authorize(client, "http://127.0.0.1:9999/other");
  expect(refused.status).toBe(400);
  expect(await refused.json()).toEqual({ error: "invalid_request" });
}, 30_000);

test("authorize requires an exact registered non-loopback redirect", async () => {
  const f = fixture({ FORGE_OAUTH_REDIRECTS: named }),
    client = await registered(f, named);
  for (const redirect of [
    `${named}/extra`,
    `${named}?x=1`,
    "https://other.example/cb",
  ]) {
    const response = await f.authorize(client, redirect);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
  }
}, 30_000);
