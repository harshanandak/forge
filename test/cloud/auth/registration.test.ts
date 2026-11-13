import { expect, mock, setDefaultTimeout, test } from "bun:test";
import { sha256 } from "../../../cloud/src/tokens.ts";
import type { RegistrationStore } from "../../../cloud/src/adapters/workers-oauth/registration.ts";
import { createOAuthHarness } from "../../adapters/workers-oauth/harness.ts";
setDefaultTimeout(30_000);
if (!("timingSafeEqual" in crypto.subtle))
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    value: crypto.timingSafeEqual.bind(crypto),
  });

await mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
const { RegistrationLimiter, REGISTRATION_LIMITS: limits } =
  await import("../../../cloud/src/adapters/workers-oauth/registration.ts");
const { createConfiguredWorker } =
  await import("../../../cloud/src/adapters/workers-oauth/compose.ts");
const redirect = "https://client.example/callback";
const metadata = {
  redirect_uris: [redirect],
  token_endpoint_auth_method: "none",
};
const ip = "203.0.113.7",
  issuer = "https://auth.example";
const privateInputs = ["203.0.113.", "private-var-marker", redirect];
function fixture() {
  let now: number = limits.windowMs,
    tail = Promise.resolve(),
    fault = "";
  const counters = new Map<string, unknown>(),
    ttls: (number | undefined)[] = [],
    mutations: string[] = [],
    lookups: string[] = [],
    entries = new Map<string, string>();
  const store = (name: string) => ({
    get: <T>(key: string) =>
      Promise.resolve(
        structuredClone(counters.get(`${name}:${key}`)) as T | undefined,
      ),
    put: (key: string, value: unknown) => {
      mutations.push(name);
      counters.set(`${name}:${key}`, structuredClone(value));
      return Promise.resolve();
    },
    delete: () => {
      mutations.push("delete");
      return Promise.resolve(true);
    },
    setAlarm: () => {
      mutations.push("alarm");
      return Promise.resolve();
    },
  });
  const storage = (name: string) => ({
    ...store(name),
    transaction<T>(run: (store: RegistrationStore) => Promise<T>) {
      const result = tail.then(() => {
        if (fault === "transaction") throw new Error("private fault");
        return run(store(name));
      });
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  });
  const namespace = {
    idFromName: (name: string) => {
      lookups.push(name);
      return name;
    },
    get: (name: string) => ({
      fetch: async (request: Request) => {
        const response = await new RegistrationLimiter(
          { storage: storage(name) },
          undefined,
          { now: () => (fault === "clock" ? NaN : now) },
        ).fetch(request);
        if (fault === "lost") throw new Error("private committed reply");
        return fault === "reply"
          ? new Response("private reply", { status: 201 })
          : response;
      },
    }),
  };
  const kv = createOAuthHarness().options.storage,
    worker = createConfiguredWorker(),
    secondWorker = createConfiguredWorker();
  const env = {
    CLERK_ISSUER: "https://clerk.example",
    CLERK_CLIENT_ID: "private-var-marker",
    CLERK_REDIRECT_URI: `${issuer}/callback`,
    FORGE_API_RESOURCE: "https://api.example/a",
    OAUTH_TIMEOUT_MS: "5000",
    FORGE_OAUTH_REDIRECTS: redirect,
    PROJECTS: {
      idFromName: () => "",
      get: () => ({
        fetch: () => {
          mutations.push("project");
          return Promise.resolve(new Response());
        },
      }),
    },
    REGISTRATION_LIMITER: namespace as unknown,
    CODE_REDEMPTION: namespace,
    GRANT_STATE: createOAuthHarness().grantNamespace,
    OAUTH_KV: {
      ...kv,
      async put(...args: Parameters<typeof kv.put>) {
        mutations.push("kv.put");
        entries.set(args[0], args[1]);
        ttls.push(args[2]?.expirationTtl);
        await kv.put(...args);
      },
      async delete(key: string) {
        mutations.push("kv.delete");
        entries.delete(key);
        await kv.delete(key);
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
  const snapshot = () => structuredClone({ counters, entries, mutations });
  return {
    register,
    counters,
    ttls,
    advance,
    env,
    snapshot,
    mutations,
    entries,
    lookups,
    send: (request: Request, second = false) =>
      (second ? secondWorker : worker).fetch(request, env),
    time: (value: number) => {
      now = value;
    },
    fault: (value: string) => {
      fault = value;
    },
  };
}
async function refused(response: Response) {
  expect(response.status).toBe(429);
  expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
  const body = await response.text();
  expect(JSON.parse(body)).toEqual({
    error: { code: "REGISTRATION_RATE_LIMITED" },
  });
  for (const value of privateInputs) expect(body).not.toContain(value);
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

type Counts = { window: number; total: number; ips: Record<string, number> };
const authKey = "authorizations:window",
  windowMs = 600_000,
  other = "203.0.113.8";
async function authFixture() {
  const f = fixture(),
    loopback = "http://127.0.0.1:53682/callback";
  const register = () =>
    f.register(ip, JSON.stringify({ ...metadata, redirect_uris: [loopback] }));
  const registered = await register();
  expect(registered.status).toBe(201);
  const client = ((await registered.json()) as { client_id: string }).client_id;
  let cookie = "";
  const start = async (
    address: string | null = ip,
    patch = {},
    suppliedCookie = cookie,
    second = false,
  ) => {
    const response = await f.send(
      new Request(
        `${issuer}/authorize?${new URLSearchParams({ response_type: "code", client_id: client, redirect_uri: loopback, resource: f.env.FORGE_API_RESOURCE, state: "state", code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256", ...patch })}`,
        {
          headers: {
            ...(address === null ? {} : { "CF-Connecting-IP": address }),
            cookie: suppliedCookie,
            "X-Forwarded-For": ip,
            "X-Real-IP": ip,
          },
        },
      ),
      second,
    );
    if (response.headers.has("Set-Cookie"))
      cookie = response.headers
        .getSetCookie()
        .map((v) => v.split(";")[0])
        .join("; ");
    return response;
  };
  const seed = async (total: number, count = 0, address = ip, key = authKey) =>
    f.counters.set(key, {
      window: key === authKey ? 6 : 1,
      total,
      ips: { [await sha256(address)]: count },
    });
  return {
    ...f,
    start,
    seed,
    register,
    counts: () => f.counters.get(authKey) as Counts,
  };
}
async function authRefused(
  f: Awaited<ReturnType<typeof authFixture>>,
  run: () => Promise<Response>,
  retry?: number,
) {
  const before = f.snapshot(),
    response = await run();
  expect(response.status).toBe(429);
  expect(await response.json()).toEqual({
    error: { code: "AUTHORIZATION_RATE_LIMITED" },
  });
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const seconds = Number(response.headers.get("Retry-After"));
  expect(Number.isInteger(seconds) && seconds >= 1 && seconds <= 600).toBe(
    true,
  );
  if (retry !== undefined) expect(seconds).toBe(retry);
  for (const header of ["Location", "Set-Cookie", "handle"])
    expect(response.headers.has(header)).toBe(false);
  expect(f.snapshot()).toEqual(before);
}
async function authAdmitted(
  f: Awaited<ReturnType<typeof authFixture>>,
  address = ip,
) {
  const before = f.snapshot(),
    response = await f.start(address);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain(
    '<form method="post" action="/authorize">',
  );
  expect(f.mutations.slice(before.mutations.length).sort()).toEqual([
    "authorizations",
    "kv.put",
  ]);
  expect(f.ttls.at(-1)).toBe(600);
  expect(f.entries.size).toBe(before.entries.size + 1);
  for (const [key, value] of before.entries)
    expect(f.entries.get(key)).toBe(value);
  expect(f.counters.get("registrations:window")).toEqual(
    before.counters.get("registrations:window"),
  );
}
test("authorization ordinary, last, N+1 and another address", async () => {
  const f = await authFixture();
  await authAdmitted(f);
  expect(f.counts()).toEqual({
    window: 6,
    total: 1,
    ips: { [await sha256(ip)]: 1 },
  });
  await f.seed(9, 9);
  await authAdmitted(f);
  await authRefused(f, () => f.start());
  await authAdmitted(f, other);
  expect(f.counts().ips[await sha256(ip)]).toBe(10);
});
test("authorization cookies, clients and varied OAuth inputs never bypass either ceiling", async () => {
  const f = await authFixture(),
    second = ((await (await f.register()).json()) as { client_id: string })
      .client_id;
  await authAdmitted(f);
  await f.seed(10, 10);
  for (const [patch, cookie] of [
    [{}, undefined],
    [{}, ""],
    [{ client_id: second }, "new=cookie"],
    [{ state: "new", code_challenge: "x".repeat(43) }, undefined],
  ] as const)
    await authRefused(f, () => f.start(ip, patch, cookie));
  await f.seed(100);
  await authRefused(f, () => f.start(other));
  expect(f.counts().ips[await sha256(other)]).toBeUndefined();
});
for (const [name, total, count, addresses] of [
  ["address", 9, 9, [ip, ip]],
  ["global", 99, 0, [other, "203.0.113.9"]],
] as const)
  test(`authorization concurrent ${name} boundary across two workers/limiters`, async () => {
    const f = await authFixture();
    await f.seed(total, count);
    const before = f.snapshot();
    const responses = await Promise.all(
      addresses.map((address, i) => f.start(address, {}, "", i === 1)),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([200, 429]);
    await authRefused(f, () =>
      Promise.resolve(responses.find((r) => r.status === 429)!),
    );
    expect(f.mutations.slice(before.mutations.length).sort()).toEqual([
      "authorizations",
      "kv.put",
    ]);
    expect(f.counts().total).toBe(total + 1);
    if (name === "address") expect(f.counts().ips[await sha256(ip)]).toBe(10);
    else
      expect(Object.values(f.counts().ips).reduce((a, b) => a + b, 0)).toBe(1);
  });
test("authorization retry rounds up and exact window rollover replaces the old record", async () => {
  const f = await authFixture();
  await f.seed(100);
  f.time(7 * windowMs - 1);
  await authRefused(f, () => f.start(), 1);
  f.time(7 * windowMs);
  await authAdmitted(f);
  expect(f.counts()).toEqual({
    window: 7,
    total: 1,
    ips: { [await sha256(ip)]: 1 },
  });
});
for (const address of [
  null,
  "",
  "203.0.113.7, 203.0.113.8",
  "bad",
  "fe80::1%eth0",
  "[::1]",
  "127.1",
  "0x7f000001",
  "256.1.1.1",
  "1.2.3.4:80",
])
  test(`authorization invalid ingress fails before DO lookup: ${address}`, async () => {
    const f = await authFixture(),
      before = [...f.lookups];
    await authRefused(f, () => f.start(address), 600);
    expect(f.lookups).toEqual(before);
  });
for (const [canonical, equivalent] of [
  [ip, ip],
  ["2001:db8::1", "2001:0DB8:0000:0000:0000:0000:0000:0001"],
  ["::ffff:c000:201", "::ffff:192.0.2.1"],
])
  test(`authorization canonical ingress quota: ${canonical}`, async () => {
    const f = await authFixture();
    await authAdmitted(f, canonical);
    await f.seed(10, 10, canonical);
    await authRefused(f, () => f.start(equivalent));
    expect(JSON.stringify([...f.counters])).not.toContain(canonical);
  });
for (const patch of [
  { client_id: "unknown" },
  { redirect_uri: "https://wrong.example" },
  { code_challenge_method: "plain" },
])
  test(`authorization malformed OAuth spends admission only under cap: ${JSON.stringify(patch)}`, async () => {
    const f = await authFixture(),
      before = f.snapshot(),
      response = await f.start(ip, patch);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(f.entries).toEqual(before.entries);
    expect(f.mutations.slice(before.mutations.length)).toEqual([
      "authorizations",
    ]);
    await f.seed(100);
    await authRefused(f, () => f.start(ip, patch));
  });
for (const fault of [
  "missing",
  "broken",
  "clock",
  "transaction",
  "reply",
  "lost",
])
  test(`authorization admission unavailable: ${fault}`, async () => {
    const f = await authFixture();
    if (fault === "missing") f.env.REGISTRATION_LIMITER = undefined;
    else if (fault === "broken") f.env.REGISTRATION_LIMITER = {};
    else f.fault(fault);
    const before = f.snapshot(),
      response = await f.start();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "AUTH_CONFIG_UNAVAILABLE",
        variable: "REGISTRATION_LIMITER",
        message: "Authorization admission unavailable",
      },
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    if (["lost", "reply"].includes(fault)) {
      expect(f.entries).toEqual(before.entries);
      expect(f.mutations.slice(before.mutations.length)).toEqual([
        "authorizations",
      ]);
      expect(f.counts().total).toBe(1);
    } else expect(f.snapshot()).toEqual(before);
  });
test("authorization and registration quotas are independent in both directions", async () => {
  const f = await authFixture();
  await f.seed(100, 5, ip, "registrations:window");
  await authAdmitted(f);
  await f.seed(0, 0, ip, "registrations:window");
  await f.seed(100);
  const before = structuredClone(f.counts());
  expect((await f.register()).status).toBe(201);
  expect(f.counts()).toEqual(before);
});

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
  const uriKey = "redirect_uris";
  for (const [field, key, value] of [
    ["body", "client_name", "??".repeat(limits.bodyBytes / 2)],
    [uriKey, uriKey, Array(limits.redirects + 1).fill(redirect)],
    [uriKey, uriKey, [redirect + "x".repeat(limits.redirectLength)]],
  ] as const) {
    const f = fixture(),
      response = await f.register(
        ip,
        JSON.stringify({ ...metadata, [key]: value }),
      );
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      error: { code: "REGISTRATION_INVALID", field },
    });
    for (const content of [...privateInputs, "??", "x".repeat(20)])
      expect(body).not.toContain(content);
    expect(f.ttls).toHaveLength(0);
    expect(f.counters.size).toBe(0);
  }
}, 30_000);
