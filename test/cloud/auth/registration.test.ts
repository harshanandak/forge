import { expect, mock, test } from "bun:test";
import type { RegistrationStore } from "../../../cloud/src/adapters/workers-oauth/registration.ts";
import { createOAuthHarness } from "../../adapters/workers-oauth/harness.ts";

await mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
const { RegistrationLimiter, REGISTRATION_LIMITS: limits } =
  await import("../../../cloud/src/adapters/workers-oauth/registration.ts");
const { createConfiguredWorker } =
  await import("../../../cloud/src/adapters/workers-oauth/compose.ts");
const metadata = {
  redirect_uris: ["https://client.example/callback"],
  token_endpoint_auth_method: "none",
};
const ip = "203.0.113.7",
  issuer = "https://auth.example";
function fixture() {
  let now = limits.windowMs,
    tail = Promise.resolve();
  const counters = new Map<string, unknown>(),
    ttls: (number | undefined)[] = [];
  const store: RegistrationStore = {
    get: <T>(key: string) =>
      Promise.resolve(counters.get(key) as T | undefined),
    put: (key, value) => {
      counters.set(key, value);
      return Promise.resolve();
    },
  };
  const storage = {
    ...store,
    transaction<T>(run: (store: RegistrationStore) => Promise<T>) {
      const result = tail.then(() => run(store));
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
  const limiter = new RegistrationLimiter({ storage }, undefined, {
    now: () => now,
  });
  const kv = createOAuthHarness().options.storage,
    worker = createConfiguredWorker();
  const env = {
    CLERK_ISSUER: "https://clerk.example",
    CLERK_CLIENT_ID: "private-var-marker",
    CLERK_REDIRECT_URI: `${issuer}/callback`,
    FORGE_API_RESOURCE: "https://api.example/a",
    OAUTH_TIMEOUT_MS: "5000",
    PROJECTS: {
      idFromName: () => "",
      get: () => ({ fetch: () => Promise.resolve(new Response()) }),
    },
    REGISTRATION_LIMITER: {
      idFromName: (name: string) => name,
      get: () => limiter,
    },
    OAUTH_KV: {
      ...kv,
      async put(...args: Parameters<typeof kv.put>) {
        ttls.push(args[2]?.expirationTtl);
        await kv.put(...args);
      },
    },
  };
  const register = (
    address: string | null = ip,
    body = JSON.stringify(metadata),
  ) => {
    const headers = new Headers({ "Content-Type": "application/json" });
    if (address) headers.set("CF-Connecting-IP", address);
    return worker.fetch(
      new Request(`${issuer}/register`, { method: "POST", headers, body }),
      env,
    );
  };
  const advance = () => {
    now += limits.windowMs;
  };
  return { register, counters, ttls, advance };
}
async function refused(response: Response) {
  expect(response.status).toBe(429);
  expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
  const body = await response.text();
  expect(JSON.parse(body)).toEqual({
    error: { code: "REGISTRATION_RATE_LIMITED" },
  });
  for (const value of [
    "203.0.113.",
    "private-var-marker",
    metadata.redirect_uris[0]!,
  ])
    expect(body).not.toContain(value);
}

test("per-IP admission is atomic, has Retry-After, and leaves another IP room", async () => {
  const f = fixture(),
    responses = await Promise.all(
      Array.from({ length: limits.perIP + 1 }, () => f.register()),
    );
  expect(responses.filter((r) => r.status === 201)).toHaveLength(limits.perIP);
  await refused(responses.find((r) => r.status !== 201)!);
  expect((await f.register("203.0.113.8")).status).toBe(201);
}, 30_000);

test("global admission is atomic across IPs and a missing trusted IP is refused", async () => {
  const f = fixture();
  await refused(await f.register(null));
  expect(f.ttls).toHaveLength(0);
  const responses = await Promise.all(
    Array.from({ length: limits.global + 1 }, (_, i) =>
      f.register(`203.0.113.${i}`),
    ),
  );
  expect(responses.filter((r) => r.status === 201)).toHaveLength(limits.global);
  await refused(responses.find((r) => r.status !== 201)!);
  expect(f.ttls).toHaveLength(limits.global);
}, 30_000);

test("window rollover replaces old counters and abandoned registrations use a day TTL", async () => {
  const f = fixture();
  for (let i = 0; i < limits.perIP; i++)
    expect((await f.register()).status).toBe(201);
  await refused(await f.register());
  f.advance();
  expect((await f.register()).status).toBe(201);
  expect(f.counters.size).toBe(1);
  expect(f.ttls).toEqual(
    Array(limits.perIP + 1).fill(limits.clientTTL) as number[],
  );
}, 30_000);

test("byte, redirect count and redirect length caps refuse before any storage", async () => {
  const redirect = metadata.redirect_uris[0]!;
  for (const [field, value] of [
    ["body", { client_name: "é".repeat(limits.bodyBytes / 2) }],
    [
      "redirect_uris",
      {
        redirect_uris: Array(limits.redirects + 1).fill(redirect),
      },
    ],
    [
      "redirect_uris",
      {
        redirect_uris: [redirect + "x".repeat(limits.redirectLength)],
      },
    ],
  ] as const) {
    const f = fixture(),
      response = await f.register(
        ip,
        JSON.stringify({ ...metadata, ...value }),
      );
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      error: { code: "REGISTRATION_INVALID", field },
    });
    for (const content of [
      ip,
      "private-var-marker",
      metadata.redirect_uris[0]!,
      "é",
      "x".repeat(20),
    ])
      expect(body).not.toContain(content);
    expect(f.ttls).toHaveLength(0);
    expect(f.counters.size).toBe(0);
  }
}, 30_000);
