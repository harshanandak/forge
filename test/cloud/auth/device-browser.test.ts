import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createDeviceBrowser } from "../../../cloud/src/auth/device-browser.ts";
import { Project } from "../../../cloud/src/project.ts";
import { durableStore, type DurableStorage } from "../../../cloud/src/store.ts";
import type { IdentityClaims } from "../../../src/ports/identity.ts";
import { testIdentityVerifier } from "../../contract/lib/identity-verifier.ts";
import { createOAuthHarness } from "../../adapters/workers-oauth/harness.ts";

if (!("timingSafeEqual" in crypto.subtle))
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    value: crypto.timingSafeEqual.bind(crypto),
  });
await mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
const { createConfiguredWorker, composeOAuth } =
  await import("../../../cloud/src/adapters/workers-oauth/compose.ts");
const databases: Database[] = [];
afterEach(() => {
  mock.restore();
  for (const db of databases.splice(0)) db.close();
});
const origin = "https://w.example";
const env = {
  FORGE_CLOUD_PROJECT: "p",
  DEVICE_LOGIN_HMAC_KEY: btoa(
    String.fromCharCode(...new Uint8Array(32).fill(7)),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", ""),
  CLERK_ISSUER: "https://clerk.example",
  CLERK_CLIENT_ID: "client",
  FORGE_OWNER_SUBJECT: "user_Owner1",
};
interface Challenge {
  user_code: string;
  device_code: string;
}

async function fixture() {
  let now = 1_800_000_000_000;
  spyOn(Date, "now").mockImplementation(() => now);
  const db = new Database(":memory:");
  databases.push(db);
  const values = new Map<string, unknown>();
  const storage: DurableStorage = {
    sql: {
      exec: (sql, ...bindings) => ({
        toArray: () =>
          db
            .query(sql)
            .all(
              ...bindings.map((value) =>
                value instanceof ArrayBuffer ? new Uint8Array(value) : value,
              ),
            ) as Record<string, unknown>[],
      }),
    },
    transactionSync: (operation) => db.transaction(operation)(),
    get: (key) => Promise.resolve(values.get(key)),
    put: (key, value) => {
      values.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => Promise.resolve(values.delete(key)),
  };
  const project = new Project({ storage }, env);
  const projectCall = (route: string, body: object, ip = "203.0.113.1") =>
    project.fetch(
      new Request(`${origin}/p/p/${route}`, {
        method: "POST",
        headers: { "CF-Connecting-IP": ip },
        body: JSON.stringify(body),
      }),
    );
  await projectCall("devices", { device: "seed", ttlMs: 86_400_000 });
  const begin = async (device = "laptop-1", ip?: string) =>
    (await (
      await projectCall("loginstart", { device }, ip)
    ).json()) as Challenge;
  const claims = (patch: Partial<IdentityClaims> = {}): IdentityClaims => ({
    issuer: env.CLERK_ISSUER,
    subject: env.FORGE_OWNER_SUBJECT,
    audience: env.CLERK_CLIENT_ID,
    authenticatedAt: now - 1_000,
    expiresAt: now + 3_600_000,
    ...patch,
  });
  let proof: IdentityClaims | undefined = claims();
  const upstream = {
    begin: mock((state: string, verifier?: string) =>
      Promise.resolve(
        `https://clerk.example/oauth/authorize?${new URLSearchParams({ state, verifier: verifier ?? "", redirect_uri: `${origin}/callback` })}`,
      ),
    ),
    verify: mock((request: Request, at: number, _verifier?: string) => {
      const code = new URL(request.url).searchParams.get("code");
      return testIdentityVerifier(
        new Map(
          proof && code && /^proof(?:-\d+)?$/.test(code) ? [[code, proof]] : [],
        ),
      ).verify(code, env.CLERK_CLIENT_ID, at);
    }),
  };
  const redeemed = new Set<string>();
  const codeRedemption = {
    claimOnce: mock((hash: string, _until: number) => {
      const fresh = !redeemed.has(hash);
      redeemed.add(hash);
      return Promise.resolve(fresh);
    }),
  };
  const options = {
    db: durableStore(storage),
    env,
    upstream,
    codeRedemption,
    now: () => now,
  };
  let browser = createDeviceBrowser(options);
  const cookies = new Map<string, string>();
  const request = (
    path: string,
    form?: Record<string, string>,
    headers: Record<string, string> = {},
  ) =>
    new Request(`${origin}${path}`, {
      headers: {
        cookie: [...cookies.values()].join("; "),
        "CF-Connecting-IP": "203.0.113.1",
        ...(form ? { Origin: origin } : {}),
        ...headers,
      },
      ...(form ? { method: "POST", body: new URLSearchParams(form) } : {}),
    });
  const send = async (
    path: string,
    form?: Record<string, string>,
    headers?: Record<string, string>,
  ) => {
    const response = await browser(request(path, form, headers));
    for (const cookie of response.headers.getSetCookie())
      cookies.set(cookie.split("=")[0]!, cookie.split(";")[0]!);
    return response;
  };
  const page = await send("/device");
  const html = await page.clone().text();
  const csrf = /name="csrf"\s+value="([^"]+)"/.exec(html)?.[1] ?? "missing";
  const decision = (user_code: string, action = "approve") =>
    send(`/device/${action}`, { user_code, csrf });
  const callbackPath = (response: Response, code = "proof") =>
    `/callback?${new URLSearchParams({ state: new URL(response.headers.get("location") ?? "https://missing.example").searchParams.get("state") ?? "missing", code })}`;
  const tokens = () =>
    Number(
      (
        db.query("SELECT COUNT(*) AS n FROM domain_cloud_tokens").get() as {
          n: number;
        }
      ).n,
    );
  const state = () =>
    String(
      (
        db.query("SELECT state FROM domain_cloud_login WHERE id=1").get() as {
          state: string;
        } | null
      )?.state ?? "{}",
    );
  return {
    page,
    html,
    csrf,
    begin,
    send,
    request,
    decision,
    callbackPath,
    tokens,
    state,
    upstream,
    codeRedemption,
    claims,
    proof: (value: IdentityClaims | undefined) => {
      proof = value;
    },
    advance: (ms: number) => {
      now += ms;
    },
    reopen: () => {
      browser = createDeviceBrowser(options);
    },
    forgetChallenges: () => {
      const saved = JSON.parse(state()) as { challenges: unknown[] };
      saved.challenges = [];
      db.query("UPDATE domain_cloud_login SET state=? WHERE id=1").run(
        JSON.stringify(saved),
      );
    },
    poll: (device_code: string) => projectCall("loginpoll", { device_code }),
  };
}

test("device page requires code entry and sets private browser protections", async () => {
  const f = await fixture();
  expect(f.page.status).toBe(200);
  expect(f.html).toContain('name="user_code"');
  expect(f.csrf).not.toBe("missing");
  expect(f.page.headers.get("cache-control")).toBe("no-store");
  expect(f.page.headers.get("referrer-policy")).toBe("no-referrer");
  expect(f.page.headers.get("x-frame-options")).toBe("DENY");
  expect(f.page.headers.get("content-security-policy")).toContain(
    "frame-ancestors 'none'",
  );
  const cookie = f.page.headers.getSetCookie().join(";");
  for (const flag of ["Secure", "HttpOnly", "SameSite=Lax", "Path=/"])
    expect(cookie).toContain(flag);
  expect(cookie).not.toContain("Domain=");
  expect(f.upstream.begin).not.toHaveBeenCalled();
  expect(f.tokens()).toBe(1);
}, 30_000);

test("preview shows project and device without granting approval", async () => {
  const f = await fixture(),
    c = await f.begin();
  const response = await f.send("/device", {
    user_code: c.user_code,
    csrf: f.csrf,
  });
  expect(response.status).toBe(200);
  const html = await response.text();
  for (const text of ["p", "laptop-1", "/device/approve", "/device/deny"])
    expect(html).toContain(text);
  for (const secret of [c.device_code, "fct_"])
    expect(html).not.toContain(secret);
  expect(f.upstream.begin).not.toHaveBeenCalled();
  expect(await (await f.poll(c.device_code)).json()).toEqual({
    ok: false,
    error: "authorization_pending",
  });
}, 30_000);

test("begin approval persists state and PKCE across handler recreation", async () => {
  const f = await fixture(),
    c = await f.begin();
  const response = await f.decision(c.user_code);
  expect(response.status).toBe(302);
  const target = new URL(response.headers.get("location")!);
  expect(target.origin).toBe(env.CLERK_ISSUER);
  expect(target.searchParams.get("redirect_uri")).toBe(`${origin}/callback`);
  const [state, verifier] = f.upstream.begin.mock.calls[0]!;
  expect(state).toMatch(/^device:/);
  expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  for (const secret of [c.user_code, c.device_code])
    expect(f.state()).not.toContain(secret);
  f.reopen();
  expect((await f.send(f.callbackPath(response))).status).toBe(200);
  expect(f.upstream.verify.mock.calls[0]?.[2]).toBe(verifier);
  expect(f.state()).not.toContain(verifier!);
  expect(f.tokens()).toBe(1);
}, 30_000);

test("owner browser approval delivers the versioned credential only to one poll", async () => {
  const f = await fixture(),
    c = await f.begin();
  const response = await f.send(f.callbackPath(await f.decision(c.user_code)));
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html.toLowerCase()).toContain("approved");
  for (const secret of [c.device_code, "fct_"])
    expect(html).not.toContain(secret);
  const one = await f.poll(c.device_code);
  expect(one.status).toBe(200);
  const body = (await one.json()) as { credential: string };
  expect(JSON.parse(body.credential)).toMatchObject({
    format: "forge/device-credential/1",
    device: "laptop-1",
  });
  expect(await (await f.poll(c.device_code)).json()).toEqual({
    ok: false,
    error: "invalid_grant",
  });
  expect(f.tokens()).toBe(2);
  expect(f.codeRedemption.claimOnce).toHaveBeenCalledTimes(1);
}, 30_000);

for (const [patch, action] of [
  [{ subject: "user_Other" }, "approve"],
  [{ issuer: "https://other.example" }, "approve"],
  [{ subject: "user_Other" }, "deny"],
  [{ issuer: "https://other.example" }, "deny"],
] as const) {
  test(`verified non-owner ${JSON.stringify(patch)} cannot ${action}`, async () => {
    const f = await fixture(),
      c = await f.begin();
    f.proof(f.claims(patch));
    const response = await f.send(
      f.callbackPath(await f.decision(c.user_code, action)),
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("AUTH_FORBIDDEN");
    expect(await (await f.poll(c.device_code)).json()).toEqual({
      ok: false,
      error: "authorization_pending",
    });
    expect(f.tokens()).toBe(1);
  }, 30_000);
}

for (const invalid of [
  "audience",
  "expired",
  "unverified",
  "future authentication",
]) {
  test(`invalid Clerk proof is refused for ${invalid}`, async () => {
    const f = await fixture(),
      c = await f.begin();
    f.proof(
      invalid === "unverified"
        ? undefined
        : f.claims(
            invalid === "audience"
              ? { audience: "other" }
              : invalid === "expired"
                ? { expiresAt: f.claims().authenticatedAt }
                : { authenticatedAt: f.claims().expiresAt },
          ),
    );
    const response = await f.send(
      f.callbackPath(await f.decision(c.user_code)),
      undefined,
      { "X-Forge-Owner": "forged" },
    );
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("AUTH_INVALID");
    expect(f.tokens()).toBe(1);
    expect(await (await f.poll(c.device_code)).json()).toEqual({
      ok: false,
      error: "authorization_pending",
    });
  }, 30_000);
}

test("owner denial leaves tokens unchanged and poll reports access_denied", async () => {
  const f = await fixture(),
    c = await f.begin();
  const response = await f.send(
    f.callbackPath(await f.decision(c.user_code, "deny")),
  );
  expect(response.status).toBe(200);
  expect((await response.text()).toLowerCase()).toContain("denied");
  const poll = await f.poll(c.device_code);
  expect(poll.status).toBe(400);
  expect(await poll.json()).toEqual({ ok: false, error: "access_denied" });
  expect(f.tokens()).toBe(1);
}, 30_000);

test("all browser posts refuse absent CSRF and cross-origin requests", async () => {
  const f = await fixture(),
    c = await f.begin();
  for (const path of ["/device", "/device/approve", "/device/deny"]) {
    for (const [form, headers] of [
      [{ user_code: c.user_code }, {}],
      [
        { user_code: c.user_code, csrf: f.csrf },
        { Origin: "https://evil.example" },
      ],
      [{ user_code: c.user_code, csrf: f.csrf }, { cookie: "" }],
    ] as const)
      expect((await f.send(path, form, headers)).status).toBe(400);
  }
  expect(f.upstream.begin).not.toHaveBeenCalled();
  expect(f.tokens()).toBe(1);
}, 30_000);

test("callback consumes state once, binds its cookie and fails closed on expiry", async () => {
  for (const mode of ["cookie", "expiry", "replay", "unknown", "missing"]) {
    const f = await fixture(),
      c = await f.begin();
    const response = await f.decision(c.user_code);
    let path = f.callbackPath(response);
    if (mode === "unknown") path = "/callback?state=device:unknown&code=proof";
    if (mode === "missing") path = "/callback?code=proof";
    if (mode === "expiry") f.advance(600_000);
    if (mode === "replay") expect((await f.send(path)).status).toBe(200);
    const refused = await f.send(
      path,
      undefined,
      mode === "cookie" ? { cookie: "" } : {},
    );
    expect(refused.status).toBe(400);
    expect(f.upstream.verify).toHaveBeenCalledTimes(mode === "replay" ? 1 : 0);
    expect(f.tokens()).toBe(1);
  }
}, 30_000);

test("durable redemption refuses the same upstream code on another browser state", async () => {
  const f = await fixture(),
    a = await f.begin(),
    b = await f.begin();
  expect(
    (await f.send(f.callbackPath(await f.decision(a.user_code)))).status,
  ).toBe(200);
  expect(
    (await f.send(f.callbackPath(await f.decision(b.user_code)))).status,
  ).toBe(400);
  expect(f.upstream.verify).toHaveBeenCalledTimes(1);
  expect(await (await f.poll(b.device_code)).json()).toEqual({
    ok: false,
    error: "authorization_pending",
  });
}, 30_000);

test("failed preview budgets are separate from starts and reset at sixty seconds", async () => {
  const f = await fixture(),
    c = await f.begin();
  for (let n = 0; n < 5; n++)
    expect(
      (await f.send("/device", { user_code: "XXXX-XXXX", csrf: f.csrf }))
        .status,
    ).toBe(400);
  expect(
    (await f.send("/device", { user_code: "XXXX-XXXX", csrf: f.csrf })).status,
  ).toBe(429);
  expect(
    (
      await f.send(
        "/device",
        { user_code: c.user_code, csrf: f.csrf },
        { "CF-Connecting-IP": "203.0.113.2" },
      )
    ).status,
  ).toBe(200);
  f.advance(60_000);
  expect(
    (await f.send("/device", { user_code: c.user_code, csrf: f.csrf })).status,
  ).toBe(200);
  expect(f.tokens()).toBe(1);
}, 30_000);

test("failed previews also stop at the shared project limit", async () => {
  const f = await fixture();
  for (let n = 0; n < 30; n++) {
    expect(
      (
        await f.send(
          "/device",
          { user_code: "XXXX-XXXX", csrf: f.csrf },
          { "CF-Connecting-IP": `198.51.100.${n}` },
        )
      ).status,
    ).toBe(400);
  }
  expect(
    (
      await f.send(
        "/device",
        { user_code: "XXXX-XXXX", csrf: f.csrf },
        { "CF-Connecting-IP": "198.51.100.99" },
      )
    ).status,
  ).toBe(429);
  f.advance(60_000);
  expect(
    (await f.send("/device", { user_code: "XXXX-XXXX", csrf: f.csrf })).status,
  ).toBe(400);
}, 30_000);

test("sixth authenticated failed decision uses the engine principal budget", async () => {
  const f = await fixture();
  for (let n = 0; n < 6; n++) {
    const c = await f.begin("laptop-1", `198.51.100.${n}`);
    const redirect = await f.decision(c.user_code);
    f.forgetChallenges();
    const response = await f.send(f.callbackPath(redirect, `proof-${n}`));
    expect(response.status).toBe(n === 5 ? 429 : 400);
  }
  expect(f.tokens()).toBe(1);
}, 30_000);

test("preview hides absent, consumed and expired codes behind the same refusal", async () => {
  const f = await fixture(),
    c = await f.begin();
  const invalid = await f.send("/device", {
    user_code: "XXXX-XXXX",
    csrf: f.csrf,
  });
  expect(invalid.status).toBe(400);
  const generic = await invalid.text();
  expect(
    (await f.send(f.callbackPath(await f.decision(c.user_code)))).status,
  ).toBe(200);
  await f.poll(c.device_code);
  const consumed = await f.send("/device", {
    user_code: c.user_code,
    csrf: f.csrf,
  });
  expect([consumed.status, await consumed.text()]).toEqual([400, generic]);
  const expired = await f.begin();
  f.advance(600_000);
  const response = await f.send("/device", {
    user_code: expired.user_code,
    csrf: f.csrf,
  });
  expect([response.status, await response.text()]).toEqual([400, generic]);
}, 30_000);

test("JSON identity claims cannot substitute for an upstream proof", async () => {
  const f = await fixture(),
    c = await f.begin();
  const response = await f.send(
    f.callbackPath(await f.decision(c.user_code), JSON.stringify(f.claims())),
  );
  expect(response.status).toBe(401);
  expect(f.tokens()).toBe(1);
}, 30_000);

test("configured Worker routes device callbacks before ordinary OAuth", async () => {
  const reached: string[] = [];
  const worker = createConfiguredWorker();
  const bindings = {
    ...env,
    PROJECTS: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: (request: Request) => {
          reached.push(new URL(request.url).pathname);
          return Promise.resolve(new Response("refused", { status: 400 }));
        },
      }),
    },
  };
  for (const path of [
    "/device",
    "/device/approve",
    "/device/deny",
    "/callback?state=device:unknown&code=proof",
  ]) {
    const response = await worker.fetch(
      new Request(
        `${origin}${path}`,
        path.includes("/device/") ? { method: "POST" } : {},
      ),
      bindings,
    );
    expect(response.status).toBe(400);
  }
  expect(reached).toEqual([
    "/device",
    "/device/approve",
    "/device/deny",
    "/callback",
  ]);
  reached.length = 0;
  await worker.fetch(
    new Request(`${origin}/callback?state=ordinary&code=proof`),
    bindings,
  );
  expect(reached).toEqual([]);
}, 30_000);

test("ordinary OAuth authorize and callback keep their existing round trip", async () => {
  const h = createOAuthHarness();
  const auth = composeOAuth(h.options, "https://api.example/a");
  const { createOAuthAdapter } =
    await import("../../../cloud/src/adapters/workers-oauth/index.ts");
  const client = await createOAuthAdapter(h.options).register(
    "https://client.example/callback",
  );
  const response = await auth.route(
    new Request(
      `https://auth.example/authorize?${new URLSearchParams({ response_type: "code", client_id: client, redirect_uri: "https://client.example/callback", state: "client-state", scope: "mcp:read", resource: "https://api.example/a", code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256" })}`,
    ),
  );
  expect(response.status).toBe(200);
  const html = await response.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)![1]!;
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const redirect = await auth.route(
    new Request("https://auth.example/authorize", {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams({ handle, allow: "true" }),
    }),
  );
  expect(redirect.status).toBe(302);
  const state = new URL(redirect.headers.get("location")!).searchParams.get(
    "state",
  )!;
  const callbackCookie = redirect.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const callback = await auth.route(
    new Request(
      `https://auth.example/callback?${new URLSearchParams({ state, proof: "proof" })}`,
      { headers: { cookie: [cookie, callbackCookie].join("; ") } },
    ),
  );
  expect(callback.status).toBe(302);
  const target = new URL(callback.headers.get("location")!);
  expect(target.searchParams.get("state")).toBe("client-state");
  expect(target.searchParams.get("code")).toBeTruthy();
}, 30_000);
