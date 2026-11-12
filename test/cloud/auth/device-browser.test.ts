import { expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { LOGIN_TTL_MS } from "../../../cloud/src/auth/project-login.ts";
import type {
  ClerkResult,
  ClerkUpstream,
} from "../../../cloud/src/adapters/workers-oauth/clerk/upstream.ts";
import { Project } from "../../../cloud/src/project.ts";
import type { DurableStorage } from "../../../cloud/src/store.ts";
import { createWorker } from "../../../cloud/src/worker.ts";
import type { IdentityClaims } from "../../../src/ports/identity.ts";
import { testIdentityVerifier } from "../../contract/lib/identity-verifier.ts";

if (!("timingSafeEqual" in crypto.subtle))
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    value: crypto.timingSafeEqual.bind(crypto),
  });
await mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
const { createConfiguredWorker } =
  await import("../../../cloud/src/adapters/workers-oauth/compose.ts");

const start = 1_800_000_000_000,
  day = 86_400_000;
const ORIGIN = "https://w.example";
const COOKIE = "__Host-forge_device";
const vars: Record<string, string> = {
  FORGE_CLOUD_PROJECT: "p",
  DEVICE_LOGIN_HMAC_KEY: Buffer.alloc(32, 7).toString("base64url"),
  CLERK_ISSUER: "https://clerk.example",
  FORGE_OWNER_SUBJECT: "user_Owner1",
  CLERK_CLIENT_ID: "client",
  CLERK_REDIRECT_URI: `${ORIGIN}/callback`,
  FORGE_API_RESOURCE: ORIGIN,
  OAUTH_TIMEOUT_MS: "5000",
  ADMIN_TOKEN: "admin-secret",
};
const secret = /^[A-Za-z0-9_-]{43}$/;
interface Body {
  ok?: boolean;
  error?: string;
  user_code: string;
  device_code: string;
  credential: string;
}
interface Reply {
  status: number;
  text: string;
  headers: Headers;
}
interface Jar {
  cookie: string;
  csrf: string;
}
interface Init {
  form?: Record<string, string>;
  json?: unknown;
  cookie?: string;
  origin?: string | null;
  ip?: string | null;
  headers?: Record<string, string>;
}
type Fetcher = { fetch: (request: Request, env: never) => Promise<Response> };
const body = (reply: Reply) => JSON.parse(reply.text) as Body;
/** The outcome word a page or a JSON refusal carries. */
const outcome = (reply: Reply): string =>
  /<code class="result">([^<]+)<\/code>/.exec(reply.text)?.[1] ??
  (JSON.parse(reply.text) as { error: { code: string } }).error.code;
const hex = async (value: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

function fixture(
  env: Record<string, string> = vars,
  extra: Record<string, unknown> = {},
) {
  let t = start;
  spyOn(Date, "now").mockImplementation(() => t);
  const db = new Database(":memory:"),
    values = new Map<string, unknown>();
  const writes = { login: 0, limiter: 0, failAfter: Infinity };
  const storage: DurableStorage = {
    sql: {
      exec: (sql, ...bindings) => {
        if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)) {
          if (/\bdomain_cloud_login\b/.test(sql)) writes.login++;
          if (
            /\bdomain_cloud_browser_attempts\b/.test(sql) &&
            ++writes.limiter > writes.failAfter
          )
            throw new Error("Injected counter write failure");
        }
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
    transactionSync: (run) => db.transaction(run)(),
    get: (key) => Promise.resolve(values.get(key)),
    put: (key, value) => {
      values.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => Promise.resolve(values.delete(key)),
  };
  const seen = {
    begun: [] as { state: string; verifier?: string | undefined }[],
    verified: [] as { url: string; verifier?: string | undefined }[],
  };
  const claims = new Map<string, number>();
  // Every identity is built at the moment of use, relative to the fixture clock.
  const scenario = (name: string): IdentityClaims => ({
    issuer: "https://clerk.example",
    subject: "user_Owner1",
    audience: "client",
    expiresAt: name === "expired" ? t - 1 : t + 3_600_000,
    authenticatedAt: t - 1_000,
    ...(name === "other-subject" ? { subject: "user_Other2" } : {}),
    ...(name === "other-issuer" ? { issuer: "https://other.example" } : {}),
    ...(name === "wrong-audience" ? { audience: "elsewhere" } : {}),
  });
  const upstream: ClerkUpstream = {
    begin: (state, verifier) => {
      seen.begun.push({ state, verifier });
      return Promise.resolve(
        `https://clerk.example/oauth/authorize?s=${state}`,
      );
    },
    verify: async (request, now, verifier) => {
      seen.verified.push({ url: request.url, verifier });
      const proof = new URL(request.url).searchParams.get("proof") ?? "";
      const known =
        proof === "forged" ? [] : ([[proof, scenario(proof)]] as const);
      const result = await testIdentityVerifier(new Map(known)).verify(
        proof,
        "client",
        now,
      );
      return {
        ...result,
        ...(result.ok ? { verifiedAudience: result.identity.audience } : {}),
      };
    },
  };
  const redemption = {
    claimOnce: (hash: string, until: number) => {
      if ((claims.get(hash) ?? 0) > t) return Promise.resolve(false);
      claims.set(hash, until);
      return Promise.resolve(true);
    },
  };
  let project = new Project({ storage }, env, { upstream, redemption });
  const reached: unknown[] = [];
  const bindings = {
    ...env,
    ...extra,
    PROJECTS: {
      idFromName: (name: string) => name,
      get: (id: unknown) => {
        reached.push(id);
        return project;
      },
    },
  };
  let worker: Fetcher = createWorker();
  async function send(path: string, init: Init = {}): Promise<Reply> {
    const method = init.form || init.json !== undefined ? "POST" : "GET";
    const headers: Record<string, string> = { ...init.headers };
    if (init.ip !== null)
      headers["CF-Connecting-IP"] = init.ip ?? "203.0.113.1";
    if (method === "POST" && init.origin !== null)
      headers.Origin = init.origin ?? ORIGIN;
    if (init.cookie) headers.Cookie = init.cookie;
    if (init.form)
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    const payload = init.form
      ? new URLSearchParams(init.form).toString()
      : init.json === undefined
        ? undefined
        : JSON.stringify(init.json);
    const response = await worker.fetch(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers,
        ...(payload === undefined ? {} : { body: payload }),
      }),
      bindings as never,
    );
    return {
      status: response.status,
      text: await response.text(),
      headers: response.headers,
    };
  }
  const rows = (sql: string) =>
    db.query(sql).all() as Record<string, unknown>[];
  const begin = (device = "laptop-1", ip = "203.0.113.1") =>
    send("/p/p/loginstart", { json: { device }, ip });
  const open = async (cookie?: string): Promise<Jar & { page: Reply }> => {
    const page = await send("/device", cookie === undefined ? {} : { cookie });
    const csrf =
      /__Host-forge_device=([^;]+)/.exec(
        page.headers.get("set-cookie") ?? "",
      )?.[1] ?? "";
    return { cookie: `${COOKIE}=${csrf}`, csrf, page };
  };
  const preview = (code: string, jar: Jar, ip = "203.0.113.1") =>
    send("/device", { form: { csrf: jar.csrf, code }, cookie: jar.cookie, ip });
  const ticketFor = (shown: Reply, action: "approve" | "deny") =>
    new RegExp(
      `action="/device/${action}"><input type="hidden" name="csrf" value="[^"]*"><input type="hidden" name="ticket" value="([^"]+)"`,
    ).exec(shown.text)?.[1] ?? "";
  const selectorFor = (shown: Reply) =>
    /name="challenge" value="([^"]*)"/.exec(shown.text)?.[1] ?? "";
  const submit = (
    action: "approve" | "deny",
    ticket: string,
    jar: Jar,
    challenge?: string,
    ip?: string | null,
  ) =>
    send(`/device/${action}`, {
      form: {
        csrf: jar.csrf,
        ticket,
        ...(challenge === undefined ? {} : { challenge }),
      },
      cookie: jar.cookie,
      ...(ip === undefined ? {} : { ip }),
    });
  // A decision follows its preview, as in the browser; a refused preview is the answer.
  const decide = async (
    action: "approve" | "deny",
    code: string,
    jar: Jar,
    ip = "203.0.113.1",
  ) => {
    const shown = await preview(code, jar, ip);
    return shown.status === 200
      ? submit(action, ticketFor(shown, action), jar, selectorFor(shown), ip)
      : shown;
  };
  // The cookie a decision sets for its own callback, as the browser would send it back.
  const bindOf = (reply: Reply) =>
    (reply.headers.get("set-cookie") ?? "").split(";")[0]!;
  const stateOf = (reply: Reply) =>
    new URL(
      reply.headers.get("location") ?? "https://none.example/",
    ).searchParams.get("s") ?? "";
  const callback = (
    state: string,
    proof: string,
    cookie?: string,
    ip?: string | null,
  ) =>
    send(
      `/callback?${new URLSearchParams({ state, code: "clerk-code", proof })}`,
      {
        ...(cookie === undefined ? {} : { cookie }),
        ...(ip === undefined ? {} : { ip }),
      },
    );
  // Each browser flow comes from its own address, so one flow never spends another's client budget.
  let addresses = 0;
  const fresh = () => `198.18.0.${++addresses}`;
  // One whole browser approval up to the Clerk redirect; `done` returns from Clerk.
  async function through(
    action: "approve" | "deny",
    proof: string,
    ip = fresh(),
  ) {
    const login = body(await begin("laptop-1", ip));
    const jar = await open();
    const decision = await decide(action, login.user_code, jar, ip);
    const state = stateOf(decision);
    const bind = bindOf(decision);
    return {
      login,
      jar,
      decision,
      state,
      bind,
      done: () => callback(state, proof, bind, ip),
    };
  }
  const poll = (device_code: string) =>
    send("/p/p/loginpoll", { json: { device_code } });
  return {
    send,
    rows,
    begin,
    open,
    preview,
    decide,
    submit,
    ticketFor,
    selectorFor,
    fresh,
    bindOf,
    stateOf,
    callback,
    through,
    poll,
    seen,
    claims,
    reached,
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    writes,
    restart: () => {
      project = new Project({ storage }, env, { upstream, redemption });
    },
    // Everything a refused browser request must leave alone: login bytes and DML, tokens, events, receipts, calls.
    frozen: () =>
      JSON.stringify([
        writes.login,
        rows("SELECT state FROM domain_cloud_login")[0]?.state ?? null,
        rows("SELECT COUNT(*) AS n FROM domain_cloud_tokens")[0]!.n,
        rows("SELECT COUNT(*) AS n FROM state_events")[0]!.n,
        rows("SELECT COUNT(*) AS n FROM domain_cloud_requests")[0]!.n,
        seen,
        [...claims.keys()],
      ]),
    limits: () => {
      try {
        return rows(
          "SELECT bucket, count, reset_at FROM domain_cloud_browser_attempts ORDER BY bucket",
        );
      } catch {
        return [];
      }
    },
    useWorker: (next: Fetcher) => {
      worker = next;
    },
    upstream,
    admin: { authorization: `Bearer ${env.ADMIN_TOKEN}` },
    provision: () =>
      send("/p/p/devices", {
        json: { device: "seed", ttlMs: day },
        headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` },
      }),
    tokens: () =>
      Number(rows("SELECT COUNT(*) AS n FROM domain_cloud_tokens")[0]!.n),
    pending: async (login: Body) => {
      const reply = await poll(login.device_code);
      return [reply.status, body(reply).error];
    },
  };
}

test("GET /device serves a fixed page and a csrf cookie, with no secret in the URL", async () => {
  const f = fixture();
  await f.provision();
  const jar = await f.open();
  expect(jar.page.status).toBe(200);
  expect(jar.csrf).toMatch(secret);
  const cookie = jar.page.headers.get("set-cookie")!;
  for (const part of ["Secure", "HttpOnly", "SameSite=Lax", "Path=/"])
    expect(cookie).toContain(part);
  expect(cookie).not.toContain("Domain");
  const headers = jar.page.headers;
  expect([
    headers.get("cache-control"),
    headers.get("x-frame-options"),
    headers.get("referrer-policy"),
  ]).toEqual(["no-store", "DENY", "no-referrer"]);
  expect(headers.get("content-security-policy")).toContain(
    "frame-ancestors 'none'",
  );
  expect(jar.page.text).toContain(`name="csrf" value="${jar.csrf}"`);
  expect(jar.page.text).toContain('action="/device"');
  const prefilled = await f.send("/device?code=BCDF-GHJK");
  expect(prefilled.text).not.toContain("BCDF-GHJK");
}, 30_000);

test("the device routes need configuration and a provisioned project", async () => {
  const lacking = fixture({ ...vars, DEVICE_LOGIN_HMAC_KEY: "" });
  const gap = await lacking.send("/device");
  expect([gap.status, outcome(gap)]).toEqual([503, "AUTH_CONFIG_UNAVAILABLE"]);
  const bare = fixture();
  const early = await bare.send("/device");
  expect([early.status, outcome(early)]).toEqual([403, "AUTH_FORBIDDEN"]);
  const noRedirect = { ...vars, CLERK_REDIRECT_URI: "" };
  const f = fixture(noRedirect);
  await f.provision();
  const login = body(await f.begin());
  const jar = await f.open();
  const refused = await f.decide("approve", login.user_code, jar);
  expect([refused.status, outcome(refused)]).toEqual([
    503,
    "AUTH_CONFIG_UNAVAILABLE",
  ]);
  expect(f.seen.begun).toEqual([]);
  expect(
    String(f.rows("SELECT state FROM domain_cloud_login")[0]!.state),
  ).not.toContain("verifier");
}, 30_000);

test("a preview shows the project and device, grants nothing and needs a same-origin csrf proof", async () => {
  const f = fixture();
  await f.provision();
  const login = body(await f.begin());
  const jar = await f.open();
  const shown = await f.preview(login.user_code, jar);
  expect(shown.status).toBe(200);
  for (const part of [
    "<code>p</code>",
    "<code>laptop-1</code>",
    'action="/device/approve"',
    'action="/device/deny"',
  ])
    expect(shown.text).toContain(part);
  expect(shown.text).not.toContain(login.device_code);
  expect((await f.preview(login.user_code.toLowerCase(), jar)).status).toBe(
    200,
  );
  expect(await f.pending(login)).toEqual([400, "authorization_pending"]);
  expect([f.tokens(), f.seen.begun.length]).toEqual([1, 0]);
  const bad: [string, Parameters<typeof f.send>[1]][] = [
    ["no cookie", { form: { csrf: jar.csrf, code: login.user_code } }],
    [
      "other cookie",
      {
        form: { csrf: jar.csrf, code: login.user_code },
        cookie: `${COOKIE}=${"x".repeat(43)}`,
      },
    ],
    ["no field", { form: { code: login.user_code }, cookie: jar.cookie }],
    [
      "no origin",
      {
        form: { csrf: jar.csrf, code: login.user_code },
        cookie: jar.cookie,
        origin: null,
      },
    ],
    [
      "foreign origin",
      {
        form: { csrf: jar.csrf, code: login.user_code },
        cookie: jar.cookie,
        origin: "https://evil.example",
      },
    ],
  ];
  for (const [, init] of bad) {
    const refused = await f.send("/device", init);
    expect([refused.status, outcome(refused)]).toEqual([
      400,
      "invalid_request",
    ]);
    const route = await f.send("/device/approve", init);
    expect([route.status, outcome(route)]).toEqual([400, "invalid_request"]);
  }
  expect(f.seen.begun).toEqual([]);
}, 30_000);

test("missing, consumed and malformed codes get one generic answer", async () => {
  const f = fixture();
  await f.provision();
  const jar = await f.open();
  const flow = await f.through("approve", "owner");
  expect((await flow.done()).status).toBe(200);
  const answers = [
    await f.preview("BBBB-BBBB", jar),
    await f.preview("not a code", jar),
    await f.preview(flow.login.user_code, jar),
  ];
  expect(answers.map((reply) => [reply.status, outcome(reply)])).toEqual([
    [400, "invalid_code"],
    [400, "invalid_code"],
    [400, "invalid_code"],
  ]);
  expect(new Set(answers.map((reply) => reply.text)).size).toBe(1);
}, 30_000);

test("failed previews are limited to five per address and thirty per project in a minute", async () => {
  const f = fixture();
  await f.provision();
  const login = body(await f.begin());
  const jar = await f.open();
  for (let n = 0; n < 5; n++)
    expect((await f.preview("BBBB-BBBB", jar)).status).toBe(400);
  const sixth = await f.preview("BBBB-BBBB", jar);
  expect([sixth.status, outcome(sixth)]).toEqual([429, "rate_limited"]);
  expect((await f.preview(login.user_code, jar)).status).toBe(429);
  expect((await f.preview(login.user_code, jar, "203.0.113.9")).status).toBe(
    200,
  );
  f.advance(59_999);
  expect((await f.preview(login.user_code, jar)).status).toBe(429);
  f.advance(1);
  expect((await f.preview(login.user_code, jar)).status).toBe(200);
  const refused = await f.send("/device", {
    form: { csrf: jar.csrf, code: login.user_code },
    cookie: jar.cookie,
    ip: null,
  });
  expect([refused.status, outcome(refused)]).toEqual([403, "AUTH_FORBIDDEN"]);
}, 30_000);

test("thirty failed previews from different addresses close the project for a minute", async () => {
  const f = fixture();
  await f.provision();
  const login = body(await f.begin());
  const jar = await f.open();
  for (let n = 0; n < 30; n++)
    expect((await f.preview("BBBB-BBBB", jar, `198.51.100.${n}`)).status).toBe(
      400,
    );
  const next = await f.preview("BBBB-BBBB", jar, "198.51.101.1");
  expect([next.status, outcome(next)]).toEqual([429, "rate_limited"]);
  expect((await f.preview(login.user_code, jar, "198.51.101.2")).status).toBe(
    429,
  );
  f.advance(60_000);
  expect((await f.preview(login.user_code, jar, "198.51.101.2")).status).toBe(
    200,
  );
}, 30_000);

test("approve and deny redirect to Clerk and keep only a hash of the state", async () => {
  const f = fixture();
  await f.provision();
  const flow = await f.through("approve", "owner");
  expect(flow.decision.status).toBe(302);
  expect(flow.decision.headers.get("cache-control")).toBe("no-store");
  const target = new URL(flow.decision.headers.get("location")!);
  expect(target.origin + target.pathname).toBe(
    "https://clerk.example/oauth/authorize",
  );
  expect(flow.state.startsWith("forge-device.")).toBe(true);
  expect(f.seen.begun).toHaveLength(1);
  expect(f.seen.begun[0]!.state).toBe(flow.state);
  expect(f.seen.begun[0]!.verifier).toMatch(secret);
  const stored = String(
    f.rows("SELECT state FROM domain_cloud_login")[0]!.state,
  );
  expect(stored).not.toContain(flow.state);
  expect(stored).toContain(f.seen.begun[0]!.verifier!);
  expect(await f.pending(flow.login)).toEqual([400, "authorization_pending"]);
  const denial = await f.through("deny", "owner", "203.0.113.2");
  expect(denial.decision.status).toBe(302);
  expect(f.seen.begun).toHaveLength(2);
  const jar = await f.open();
  const unknown = await f.decide("approve", "BBBB-BBBB", jar);
  expect([unknown.status, outcome(unknown)]).toEqual([400, "invalid_code"]);
  expect(f.seen.begun).toHaveLength(2);
  const dump = await f.send("/p/p/dump", { headers: f.admin });
  for (const value of [flow.state, f.seen.begun[0]!.verifier!, flow.jar.csrf])
    expect(dump.text).not.toContain(value);
}, 30_000);

test("the owner approves in the browser and only the polling device receives the token", async () => {
  const logs = [spyOn(console, "log"), spyOn(console, "error")];
  const f = fixture();
  await f.provision();
  const flow = await f.through("approve", "owner");
  const done = await flow.done();
  expect([done.status, outcome(done)]).toEqual([200, "approved"]);
  expect(done.headers.get("cache-control")).toBe("no-store");
  expect(done.text).not.toContain("fct_");
  expect(f.tokens()).toBe(1);
  const verifier = f.seen.begun[0]!.verifier!;
  expect(f.seen.verified.map((call) => call.verifier)).toEqual([verifier]);
  expect([...f.claims.keys()]).toEqual([
    await hex(`device-upstream:${verifier}`),
  ]);
  expect(
    String(f.rows("SELECT state FROM domain_cloud_login")[0]!.state),
  ).not.toContain(verifier);
  const won = await f.poll(flow.login.device_code);
  expect([won.status, won.headers.get("cache-control")]).toEqual([
    200,
    "no-store",
  ]);
  const credential = JSON.parse(body(won).credential) as {
    token: string;
    expiresAt: string;
  };
  expect(credential.token).toMatch(/^fct_[0-9a-f]{16}\./);
  expect(credential.expiresAt).toBe(
    new Date(f.now() + LOGIN_TTL_MS).toISOString(),
  );
  expect(f.tokens()).toBe(2);
  expect((await f.poll(flow.login.device_code)).status).toBe(400);
  const seen = JSON.stringify(logs.flatMap((spy) => spy.mock.calls));
  for (const value of [
    flow.jar.csrf,
    flow.state,
    verifier,
    flow.login.user_code,
    flow.login.device_code,
    credential.token,
  ])
    expect(seen).not.toContain(value);
}, 30_000);

test("a denial in the browser makes the poll fail and mints nothing", async () => {
  const f = fixture();
  await f.provision();
  const flow = await f.through("deny", "owner");
  const done = await flow.done();
  expect([done.status, outcome(done)]).toEqual([200, "denied"]);
  const polled = await f.poll(flow.login.device_code);
  expect([polled.status, body(polled).error]).toEqual([400, "access_denied"]);
  expect(f.tokens()).toBe(1);
}, 30_000);

test("another Clerk user cannot approve or deny, and the challenge stays pending", async () => {
  const f = fixture();
  await f.provision();
  for (const [action, proof] of [
    ["approve", "other-subject"],
    ["approve", "other-issuer"],
    ["deny", "other-subject"],
  ] as const) {
    const flow = await f.through(action, proof);
    const done = await flow.done();
    expect([done.status, outcome(done)]).toEqual([403, "AUTH_FORBIDDEN"]);
    expect(await f.pending(flow.login)).toEqual([400, "authorization_pending"]);
  }
  expect(f.tokens()).toBe(1);
  const flow = await f.through("approve", "other-subject");
  expect((await flow.done()).status).toBe(403);
  const again = await f.decide("approve", flow.login.user_code, flow.jar);
  const owner = await f.callback(f.stateOf(again), "owner", f.bindOf(again));
  expect([owner.status, outcome(owner)]).toEqual([200, "approved"]);
}, 30_000);

test("a forged, foreign or unverified proof decides nothing", async () => {
  const f = fixture();
  await f.provision();
  for (const proof of ["forged", "wrong-audience", "expired"]) {
    const flow = await f.through("approve", proof);
    const done = await flow.done();
    expect([done.status, outcome(done)]).toEqual([401, "AUTH_INVALID"]);
    expect(await f.pending(flow.login)).toEqual([400, "authorization_pending"]);
  }
  // A verifier that returns bare claims, not a minted identity, is not accepted.
  f.upstream.verify = () =>
    Promise.resolve({
      ok: true,
      identity: {
        issuer: "https://clerk.example",
        subject: "user_Owner1",
        audience: "client",
        expiresAt: f.now() + 3_600_000,
        authenticatedAt: f.now() - 1_000,
      },
    } as unknown as ClerkResult);
  const flow = await f.through("approve", "owner");
  const done = await flow.done();
  expect([done.status, outcome(done)]).toEqual([401, "AUTH_INVALID"]);
  expect(await f.pending(flow.login)).toEqual([400, "authorization_pending"]);
  expect(f.tokens()).toBe(1);
}, 30_000);

test("a callback state is used once, only by its own browser, before its deadline", async () => {
  const f = fixture();
  await f.provision();
  const refused = (reply: Reply) => [reply.status, outcome(reply)];
  const once = await f.through("approve", "owner");
  expect((await once.done()).status).toBe(200);
  expect(refused(await once.done())).toEqual([400, "access_denied"]);
  expect(f.seen.verified).toHaveLength(1);
  const wrong = await f.through("approve", "owner");
  expect(
    refused(
      await f.callback(
        wrong.state,
        "owner",
        `${wrong.bind.split("=")[0]}=${"x".repeat(43)}`,
      ),
    ),
  ).toEqual([400, "access_denied"]);
  // The wrong browser no longer burns the state: its owner still completes (main burned it here).
  expect(refused(await wrong.done())).toEqual([200, "approved"]);
  const bare = await f.through("approve", "owner");
  expect(refused(await f.callback(bare.state, "owner"))).toEqual([
    400,
    "access_denied",
  ]);
  expect(
    refused(await f.callback("forge-device.unknown", "owner", once.jar.cookie)),
  ).toEqual([400, "access_denied"]);
  const lost = await f.through("approve", "owner");
  f.claims.set(
    await hex(`device-upstream:${f.seen.begun.at(-1)!.verifier}`),
    f.now() + day,
  );
  expect(refused(await lost.done())).toEqual([400, "access_denied"]);
  expect(f.seen.verified).toHaveLength(2);
  const late = await f.through("approve", "owner");
  f.advance(599_999);
  expect((await late.done()).status).toBe(200);
  const expired = await f.through("approve", "owner");
  f.advance(600_000);
  expect(refused(await expired.done())).toEqual([400, "access_denied"]);
  expect(f.seen.verified).toHaveLength(3);
}, 30_000);

test("the sixth failed decision by the owner within a minute is rate limited", async () => {
  const f = fixture();
  await f.provision();
  const jar = await f.open();
  const ip = (n: number) => `198.51.100.${n}`;
  const logins: Body[] = [];
  for (let n = 0; n < 6; n++)
    logins.push(body(await f.begin("laptop-1", ip(n))));
  f.advance(5_000);
  const states: Reply[] = [];
  for (const [n, login] of logins.entries())
    states.push(await f.decide("approve", login.user_code, jar, ip(n)));
  f.advance(596_000);
  await f.begin("laptop-2", ip(9));
  const results: Reply[] = [];
  for (const [n, decision] of states.entries())
    results.push(
      await f.callback(f.stateOf(decision), "owner", f.bindOf(decision), ip(n)),
    );
  expect(results.map((reply) => [reply.status, outcome(reply)])).toEqual([
    ...Array.from({ length: 5 }, () => [400, "invalid_user_code"]),
    [429, "rate_limited"],
  ]);
  expect(f.tokens()).toBe(1);
}, 30_000);

test("a device state never reaches the OAuth callback, and an OAuth state never reaches the device handler", async () => {
  const kv = {
    get: mock(() => Promise.resolve(null)),
    put: mock(() => Promise.resolve()),
    delete: mock(() => Promise.resolve()),
    list: mock(() => Promise.resolve({ keys: [], list_complete: true })),
  };
  const f = fixture(vars, {
    OAUTH_KV: kv,
    CODE_REDEMPTION: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: () => Promise.resolve(new Response(null, { status: 400 })),
      }),
    },
  });
  f.useWorker(createConfiguredWorker());
  await f.provision();
  const refused = (reply: Reply) => [reply.status, outcome(reply)];
  const unknown = await f.send("/callback?state=forge-device.unknown&code=x");
  expect(refused(unknown)).toEqual([400, "access_denied"]);
  const replayed = await f.through("approve", "owner");
  expect((await replayed.done()).status).toBe(200);
  expect(refused(await replayed.done())).toEqual([400, "access_denied"]);
  const expired = await f.through("approve", "owner");
  f.advance(600_000);
  expect(refused(await expired.done())).toEqual([400, "access_denied"]);
  expect(kv.get).not.toHaveBeenCalled();
  const verified = f.seen.verified.length;
  const reachedBefore = f.reached.length;
  // The provider's own refusal, as on main today: an unbound state is invalid_request.
  const ordinary = await f.send("/callback?state=ordinary&code=x");
  expect([ordinary.status, JSON.parse(ordinary.text)]).toEqual([
    400,
    { error: "invalid_request" },
  ]);
  expect([f.reached.length, f.seen.verified.length]).toEqual([
    reachedBefore,
    verified,
  ]);
}, 30_000);

test("a stolen or planted page cookie cannot finish a redirect for another browser", async () => {
  const f = fixture();
  await f.provision();
  const owner = await f.open();
  const attacker = body(await f.begin("evil-box"));
  // The attacker holds the owner's page cookie and runs the whole page flow with their own code.
  const shown = await f.preview(attacker.user_code, owner);
  expect(shown.status).toBe(200);
  const ticket = f.ticketFor(shown, "approve");
  for (const [action, proof] of [
    ["deny", ticket],
    ["approve", "x".repeat(43)],
    ["approve", ""],
  ] as const) {
    const refused = await f.submit(action, proof, owner);
    expect([refused.status, outcome(refused)]).toEqual([
      400,
      "invalid_request",
    ]);
  }
  expect(f.seen.begun).toEqual([]);
  const decision = await f.submit(
    "approve",
    ticket,
    owner,
    f.selectorFor(shown),
  );
  expect(decision.status).toBe(302);
  const set = decision.headers.get("set-cookie")!;
  expect(set.startsWith("__Host-forge_device_")).toBe(true);
  for (const part of ["Secure", "HttpOnly", "SameSite=Lax", "Path=/"])
    expect(set).toContain(part);
  expect((await f.submit("approve", ticket, owner)).status).toBe(400);
  // The owner's browser follows the Clerk link with only the page cookie it already had. Six attempts
  // on one challenge are over its five-a-minute bound, so the check waits for the next window.
  f.advance(60_000);
  const phished = await f.callback(f.stateOf(decision), "owner", owner.cookie);
  expect([phished.status, outcome(phished)]).toEqual([400, "access_denied"]);
  expect(f.seen.verified).toEqual([]);
  expect(await f.pending(attacker)).toEqual([400, "authorization_pending"]);
  expect(f.tokens()).toBe(1);
}, 30_000);

test("overlapping previews cannot evaluate more guesses than the budget allows", async () => {
  const f = fixture();
  await f.provision();
  const login = body(await f.begin());
  const jar = await f.open();
  const real = crypto.subtle.sign.bind(crypto.subtle) as (
    ...args: unknown[]
  ) => Promise<ArrayBuffer>;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Every code check waits at its HMAC until all eight requests are in flight.
  const spy = spyOn(crypto.subtle, "sign").mockImplementation(
    (...args: unknown[]) => gate.then(() => real(...args)),
  );
  try {
    const runs = Array.from({ length: 8 }, () => f.preview("BBBB-BBBB", jar));
    await new Promise((resolve) => setTimeout(resolve, 25));
    release();
    const replies = await Promise.all(runs);
    expect(replies.filter((reply) => reply.status === 400)).toHaveLength(5);
    expect(replies.filter((reply) => reply.status === 429)).toHaveLength(3);
  } finally {
    spy.mockRestore();
  }
  expect((await f.preview(login.user_code, jar)).status).toBe(429);
}, 30_000);

test("repeating a decision replaces the old one, and one challenge holds only a few records", async () => {
  const f = fixture();
  await f.provision();
  const login = body(await f.begin());
  const jar = await f.open();
  const held = () =>
    (
      JSON.parse(
        String(f.rows("SELECT state FROM domain_cloud_login")[0]!.state),
      ) as { browser: unknown[] }
    ).browser.length;
  const decisions: Reply[] = [];
  for (let n = 0; n < 4; n++)
    decisions.push(await f.decide("approve", login.user_code, jar));
  expect(held()).toBe(1);
  const old = await f.callback(
    f.stateOf(decisions[0]!),
    "owner",
    f.bindOf(decisions[0]!),
  );
  expect([old.status, outcome(old)]).toEqual([400, "access_denied"]);
  for (let n = 0; n < 5; n++) await f.preview(login.user_code, await f.open());
  expect(held()).toBe(3);
}, 30_000);

test("a second tab keeps the page cookie, so the first tab still completes", async () => {
  const f = fixture();
  await f.provision();
  const a = body(await f.begin("laptop-1"));
  const b = body(await f.begin("laptop-2", "203.0.113.2"));
  const tab1 = await f.open();
  const tab2 = await f.open(tab1.cookie);
  expect(tab2.csrf).toBe(tab1.csrf);
  const odd = await f.open(`${COOKIE}=short`);
  expect(odd.csrf).toMatch(secret);
  const first = await f.decide("approve", a.user_code, tab1);
  const second = await f.decide("approve", b.user_code, tab2);
  const one = await f.callback(f.stateOf(first), "owner", f.bindOf(first));
  const two = await f.callback(f.stateOf(second), "owner", f.bindOf(second));
  expect([one.status, two.status]).toEqual([200, 200]);
}, 30_000);

type Fixture = ReturnType<typeof fixture>;
const WRONG = "x".repeat(43);
// A redirect has no body, so it has no outcome word.
const pair = (reply: Reply) => [
  reply.status,
  reply.text === "" ? "" : outcome(reply),
];
/** A live preview of a fresh challenge: its browser, both tickets and the challenge selector. */
async function previewed(f: Fixture) {
  const login = body(await f.begin("laptop-1", f.fresh()));
  const jar = await f.open();
  const shown = await f.preview(login.user_code, jar);
  const ticket = (action: "approve" | "deny") => f.ticketFor(shown, action);
  return { login, jar, selector: f.selectorFor(shown), ticket };
}
type Preview = Awaited<ReturnType<typeof previewed>>;
// A decision from its own address: a wrong ticket unless one is given.
const post = (
  f: Fixture,
  p: Preview,
  o: {
    action?: "approve" | "deny";
    ticket?: string;
    selector?: string;
    ip?: string | null;
  } = {},
) =>
  f.submit(
    o.action ?? "approve",
    o.ticket ?? WRONG,
    p.jar,
    o.selector ?? p.selector,
    "ip" in o ? o.ip : f.fresh(),
  );
const right = (
  f: Fixture,
  p: Preview,
  action: "approve" | "deny" = "approve",
) => post(f, p, { action, ticket: p.ticket(action) });
const finish = (f: Fixture, decision: Reply, ip: string | null = f.fresh()) =>
  f.callback(f.stateOf(decision), "owner", f.bindOf(decision), ip);

test("a wrong ticket or selector writes nothing and leaves the right ones usable", async () => {
  for (const action of ["approve", "deny"] as const) {
    const f = fixture();
    await f.provision();
    // An unrelated browser record that expires before the refusals: they must not prune it.
    await previewed(f);
    f.advance(300_000);
    const [p, other] = [await previewed(f), await previewed(f)];
    f.advance(300_001);
    const before = f.frozen();
    const swap = action === "approve" ? "deny" : "approve";
    for (const o of [
      { ticket: "" },
      { ticket: p.ticket(swap) },
      { ticket: p.ticket(action), selector: "" },
      { ticket: p.ticket(action), selector: "0".repeat(64) },
      { ticket: p.ticket(action), selector: other.selector },
    ]) {
      expect(pair(await post(f, p, { action, ...o }))).toEqual([
        400,
        "invalid_request",
      ]);
      expect(f.frozen()).toBe(before);
    }
    const decision = await post(f, p, { action, ticket: p.ticket(action) });
    expect(decision.status).toBe(302);
    expect(pair(await finish(f, decision))).toEqual([
      200,
      action === "approve" ? "approved" : "denied",
    ]);
    // Only polling yields a credential, once; a denial never does.
    const polled = await f.poll(p.login.device_code);
    expect([polled.status, (await f.poll(p.login.device_code)).status]).toEqual(
      action === "approve" ? [200, 400] : [400, 400],
    );
    expect(f.tokens()).toBe(action === "approve" ? 2 : 1);
  }
}, 30_000);

test("a wrong browser cannot burn a callback state, and a refused callback writes nothing", async () => {
  const f = fixture();
  await f.provision();
  const flow = await f.through("approve", "owner");
  const twice = new URLSearchParams([
    ["state", flow.state],
    ["state", flow.state],
    ["proof", "owner"],
  ]);
  const before = f.frozen();
  for (const reply of [
    await f.callback(
      flow.state,
      "owner",
      `${flow.bind.split("=")[0]}=${WRONG}`,
      f.fresh(),
    ),
    await f.callback(flow.state, "owner", undefined, f.fresh()),
    await f.send(`/callback?${twice}`, { cookie: flow.bind, ip: f.fresh() }),
  ]) {
    expect(pair(reply)).toEqual([400, "access_denied"]);
    expect(f.frozen()).toBe(before);
  }
  expect(
    pair(await f.callback(flow.state, "owner", flow.bind, f.fresh())),
  ).toEqual([200, "approved"]);
  const late = await f.through("approve", "owner");
  f.advance(600_000);
  const expired = f.frozen();
  for (const state of [flow.state, "forge-device.unknown", late.state]) {
    expect(
      pair(await f.callback(state, "owner", late.bind, f.fresh())),
    ).toEqual([400, "access_denied"]);
    expect(f.frozen()).toBe(expired);
  }
  expect(f.seen.verified).toHaveLength(1);
  // Two valid callbacks for one state: one decision.
  const twin = await f.through("deny", "owner");
  const both = await Promise.all([
    twin.done(),
    f.callback(twin.state, "owner", twin.bind, f.fresh()),
  ]);
  expect(both.map(pair).sort()).toEqual([
    [200, "denied"],
    [400, "access_denied"],
  ]);
  expect([f.seen.verified.length, f.claims.size]).toEqual([2, 2]);
}, 30_000);

test("a challenge allows five attempts a minute, whoever makes them", async () => {
  const f = fixture();
  await f.provision();
  const a = await previewed(f);
  // Five wrong tickets from five addresses, across both actions and new browsers.
  for (let n = 0; n < 5; n++) {
    const jar = await f.open();
    const shown = await f.preview(a.login.user_code, jar);
    const reply = await f.submit(
      n % 2 ? "deny" : "approve",
      WRONG,
      jar,
      f.selectorFor(shown),
      f.fresh(),
    );
    expect(pair(reply)).toEqual([400, "invalid_request"]);
  }
  const fresh = await f.open();
  const shown = await f.preview(a.login.user_code, fresh);
  const sixth = (ticket: string) =>
    f.submit("approve", ticket, fresh, f.selectorFor(shown), f.fresh());
  const [frozen, limits] = [f.frozen(), f.limits()];
  expect(pair(await sixth(WRONG))).toEqual([429, "rate_limited"]);
  expect([f.frozen(), f.limits()]).toEqual([frozen, limits]);
  // The right ticket is a bound proof, not a guess: no wait, and no counter moves.
  expect((await sixth(f.ticketFor(shown, "approve"))).status).toBe(302);
  expect(f.limits()).toEqual(limits);
  // A known callback state is the same challenge: five wrong tickets fill it, then the callback finishes.
  const b = await previewed(f);
  const decision = await right(f, b);
  f.advance(60_000); // only the guesses fill the next window
  for (let n = 0; n < 5; n++)
    expect(pair(await post(f, b))).toEqual([400, "invalid_request"]);
  expect(pair(await post(f, b))).toEqual([429, "rate_limited"]);
  const spent = f.limits();
  expect(pair(await finish(f, decision))).toEqual([200, "approved"]);
  expect([f.limits(), f.seen.verified.length]).toEqual([spent, 1]);
}, 30_000);

test("an address allows five attempts a minute, and the project thirty", async () => {
  const f = fixture();
  await f.provision();
  const [a, b] = [await previewed(f), await previewed(f)];
  const x = "192.0.2.77";
  const unknown = (state: string) =>
    f.callback(`forge-device.${state}`, "owner", undefined, x);
  const first = [
    await post(f, a, { ip: x }),
    await post(f, b, { action: "deny", ip: x }),
    await unknown("one"),
    await post(f, a, { ip: x }),
    await unknown("two"),
  ];
  expect(first.map(pair)).toEqual([
    [400, "invalid_request"],
    [400, "invalid_request"],
    [400, "access_denied"],
    [400, "invalid_request"],
    [400, "access_denied"],
  ]);
  const [frozen, limits] = [f.frozen(), f.limits()];
  expect(pair(await post(f, a, { ip: x }))).toEqual([429, "rate_limited"]);
  expect([f.frozen(), f.limits()]).toEqual([frozen, limits]);
  // The right ticket from that same address is a bound proof: no wait, and no counter moves.
  expect(
    (await post(f, a, { ip: x, ticket: a.ticket("approve") })).status,
  ).toBe(302);
  expect(f.limits()).toEqual(limits);
  // The window boundary: refusals did not move it.
  f.advance(59_999);
  expect((await post(f, a, { ip: x })).status).toBe(429);
  f.advance(1);
  expect((await post(f, a, { ip: x })).status).toBe(400);
  // Thirty admitted attempts from other addresses close the project.
  for (let n = 0; n < 6; n++) {
    const p = await previewed(f);
    for (let k = 0; k < (n === 5 ? 4 : 5); k++)
      expect((await post(f, p)).status).toBe(400);
  }
  const last = await previewed(f);
  expect(pair(await post(f, last))).toEqual([429, "rate_limited"]);
  expect((await right(f, last)).status).toBe(302);
}, 30_000);

test("each protected route needs a client address before it writes or calls out", async () => {
  const f = fixture();
  await f.provision();
  const p = await previewed(f);
  const before = f.frozen();
  for (const ip of [null, ""])
    for (const reply of [
      await post(f, p, { ip, ticket: p.ticket("approve") }),
      await post(f, p, { ip, action: "deny", ticket: p.ticket("deny") }),
      await f.callback("forge-device.unknown", "owner", undefined, ip),
    ])
      expect(pair(reply)).toEqual([403, "AUTH_FORBIDDEN"]);
  expect([f.frozen(), f.limits()]).toEqual([before, []]);
}, 30_000);

test("overlapping attempts cannot overspend the challenge or the address", async () => {
  for (const bound of ["challenge", "client"] as const) {
    const f = fixture();
    await f.provision();
    const p = await previewed(f);
    const real = crypto.subtle.digest.bind(crypto.subtle) as (
      ...args: unknown[]
    ) => Promise<ArrayBuffer>;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const x = f.fresh();
    // Every request waits at its first hash, before admission, until all six are in flight.
    const spy = spyOn(crypto.subtle, "digest").mockImplementation(
      (...args: unknown[]) => gate.then(() => real(...args)),
    );
    try {
      const runs = Array.from({ length: 6 }, () =>
        bound === "challenge"
          ? post(f, p)
          : post(f, p, { ip: x, selector: "" }),
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      release();
      const statuses = (await Promise.all(runs)).map((reply) => reply.status);
      expect(statuses.filter((status) => status === 400)).toHaveLength(5);
      expect(statuses.filter((status) => status === 429)).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  }
}, 30_000);

test("the budget survives a restart, and a failed counter write changes nothing", async () => {
  const f = fixture();
  await f.provision();
  const p = await previewed(f);
  for (let n = 0; n < 3; n++) await post(f, p);
  f.restart();
  for (let n = 0; n < 2; n++) expect((await post(f, p)).status).toBe(400);
  expect(pair(await post(f, p))).toEqual([429, "rate_limited"]);

  const g = fixture();
  await g.provision();
  const q = await previewed(g);
  // One admitted attempt first, so every bucket has a row whose count a leaked charge would change.
  expect((await post(g, q)).status).toBe(400);
  const [frozen, limits] = [g.frozen(), g.limits()];
  expect(limits).toHaveLength(3);
  // The expired-row delete and the project bucket write succeed, then the address bucket write fails:
  // no bucket may keep a partial charge.
  g.writes.failAfter = g.writes.limiter + 2;
  expect(pair(await post(g, q))).toEqual([500, "INTERNAL"]);
  expect([g.frozen(), g.limits()]).toEqual([frozen, limits]);
  g.writes.failAfter = Infinity;
  expect((await right(g, q)).status).toBe(302);
}, 30_000);

// Bound proofs against full guess budgets (forge-1303). A guess is any attempt without a complete bound
// proof; a right ticket, or a right state with its own cookie, is a proof and neither checks nor spends.
const ACTIONS = ["approve", "deny"] as const;
const BUCKETS = ["project", "challenge", "address"] as const;
const finished = (action: "approve" | "deny") =>
  action === "approve" ? "approved" : "denied";
// An unknown callback state: a guess that spends the address and the project only.
const guess = (f: Fixture, ip: string | null = f.fresh()) =>
  f.callback(`forge-device.${crypto.randomUUID()}`, "owner", undefined, ip);
const wrongBind = (f: Fixture, decision: Reply) =>
  `${f.bindOf(decision).split("=")[0]}=${WRONG}`;
/** Fills one guess budget with admitted guesses, then asserts the next guess is refused. */
async function fill(
  f: Fixture,
  bucket: (typeof BUCKETS)[number],
  p: Preview,
  ip: string,
  named: () => Promise<Reply>,
) {
  const tries: Record<
    (typeof BUCKETS)[number],
    [number, (n: number) => Promise<Reply>]
  > = {
    project: [30, () => guess(f)],
    challenge: [5, named],
    address: [
      5,
      (n) => (n % 2 ? post(f, p, { ip, selector: "" }) : guess(f, ip)),
    ],
  };
  const [cap, attempt] = tries[bucket];
  for (let n = 0; n < cap; n++) expect((await attempt(n)).status).toBe(400);
  expect(pair(await attempt(cap))).toEqual([429, "rate_limited"]);
}
/** Starts every run, holds them at their first hash until all are in flight, then releases them. */
async function together<T>(runs: (() => Promise<T>)[]): Promise<T[]> {
  const real = crypto.subtle.digest.bind(crypto.subtle) as (
    ...args: unknown[]
  ) => Promise<ArrayBuffer>;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy = spyOn(crypto.subtle, "digest").mockImplementation(
    (...args: unknown[]) => gate.then(() => real(...args)),
  );
  try {
    const started = runs.map((run) => run());
    await new Promise((resolve) => setTimeout(resolve, 25));
    release();
    return await Promise.all(started);
  } finally {
    spy.mockRestore();
  }
}

test("a right ticket completes while any guess budget is full, and spends nothing", async () => {
  for (const bucket of BUCKETS)
    for (const action of ACTIONS) {
      const f = fixture();
      await f.provision();
      const p = await previewed(f);
      const ip = f.fresh();
      await fill(f, bucket, p, ip, () => post(f, p));
      const spent = [f.limits(), f.writes.limiter];
      const decision = await post(f, p, {
        action,
        ticket: p.ticket(action),
        ip,
      });
      expect(decision.status).toBe(302);
      expect([f.limits(), f.writes.limiter]).toEqual(spent);
      expect(pair(await finish(f, decision, ip))).toEqual([
        200,
        finished(action),
      ]);
      expect([f.limits(), f.writes.limiter]).toEqual(spent);
      expect(f.seen.verified).toHaveLength(1);
      expect((await f.poll(p.login.device_code)).status).toBe(
        action === "approve" ? 200 : 400,
      );
    }
}, 30_000);

test("a bound callback completes while any guess budget is full, and spends nothing", async () => {
  for (const bucket of BUCKETS)
    for (const action of ACTIONS) {
      const f = fixture();
      await f.provision();
      const p = await previewed(f);
      const decision = await right(f, p, action);
      expect(decision.status).toBe(302);
      f.advance(60_000); // only the guesses fill the next window
      const ip = f.fresh();
      const wrong = () =>
        f.callback(
          f.stateOf(decision),
          "owner",
          wrongBind(f, decision),
          f.fresh(),
        );
      await fill(f, bucket, p, ip, wrong);
      const spent = [f.limits(), f.writes.limiter];
      expect(pair(await finish(f, decision, ip))).toEqual([
        200,
        finished(action),
      ]);
      expect([f.limits(), f.writes.limiter]).toEqual(spent);
      expect(f.seen.verified).toHaveLength(1);
    }
}, 30_000);

const wrongJar = { cookie: `${COOKIE}=${WRONG}`, csrf: WRONG };
const incompletePost: Record<
  string,
  (f: Fixture, p: Preview, ip: string) => Promise<Reply>
> = {
  "wrong action": (f, p, ip) =>
    f.submit("deny", p.ticket("approve"), p.jar, p.selector, ip),
  "wrong selector": (f, p, ip) =>
    f.submit("approve", p.ticket("approve"), p.jar, "0".repeat(64), ip),
  "another browser": (f, p, ip) =>
    f.submit("approve", p.ticket("approve"), wrongJar, p.selector, ip),
  "another csrf": (f, p, ip) =>
    f.submit(
      "approve",
      p.ticket("approve"),
      { cookie: p.jar.cookie, csrf: WRONG },
      p.selector,
      ip,
    ),
  "another origin": (f, p, ip) =>
    f.send("/device/approve", {
      form: {
        csrf: p.jar.csrf,
        ticket: p.ticket("approve"),
        challenge: p.selector,
      },
      cookie: p.jar.cookie,
      origin: "https://evil.example",
      ip,
    }),
  "selector alone": (f, p, ip) =>
    f.submit("approve", WRONG, p.jar, p.selector, ip),
  "page cookie alone": (f, p, ip) =>
    f.submit("approve", WRONG, p.jar, undefined, ip),
};
type Flow = Awaited<ReturnType<Fixture["through"]>>;
const incompleteCallback: Record<
  string,
  {
    prepare?: (f: Fixture, flow: Flow) => Promise<void> | void;
    attempt: (f: Fixture, flow: Flow, ip: string) => Promise<Reply>;
  }
> = {
  "no cookie": {
    attempt: (f, flow, ip) => f.callback(flow.state, "owner", undefined, ip),
  },
  "wrong cookie": {
    attempt: (f, flow, ip) =>
      f.callback(flow.state, "owner", wrongBind(f, flow.decision), ip),
  },
  "duplicate state": {
    attempt: (f, flow, ip) =>
      f.send(
        `/callback?${new URLSearchParams([
          ["state", flow.state],
          ["state", flow.state],
          ["proof", "owner"],
        ])}`,
        { cookie: flow.bind, ip },
      ),
  },
  "unknown state": {
    attempt: (f, flow, ip) =>
      f.callback("forge-device.unknown", "owner", flow.bind, ip),
  },
  "expired state": {
    prepare: (f) => f.advance(600_000),
    attempt: (f, flow, ip) => f.callback(flow.state, "owner", flow.bind, ip),
  },
  "replayed state": {
    // Used once by its own browser before the replay.
    prepare: async (_f, flow) => {
      expect((await flow.done()).status).toBe(200);
    },
    attempt: (f, flow, ip) => f.callback(flow.state, "owner", flow.bind, ip),
  },
};

test("an incomplete POST proof stays a guess: refused below the cap and at it, writing nothing", async () => {
  for (const [name, attempt] of Object.entries(incompletePost)) {
    const f = fixture();
    await f.provision();
    const p = await previewed(f);
    const before = f.frozen();
    const below = await attempt(f, p, f.fresh());
    expect([name, pair(below)]).toEqual([name, [400, "invalid_request"]]);
    expect(f.frozen()).toBe(before);
    f.advance(60_000);
    await fill(f, "project", p, f.fresh(), () => post(f, p));
    const [full, limits] = [f.frozen(), f.limits()];
    const refused = await attempt(f, p, f.fresh());
    expect([name, pair(refused)]).toEqual([name, [429, "rate_limited"]]);
    expect([f.frozen(), f.limits()]).toEqual([full, limits]);
  }
}, 30_000);

test("an incomplete callback proof stays a guess: refused below the cap and at it, writing nothing", async () => {
  for (const [name, { prepare, attempt }] of Object.entries(
    incompleteCallback,
  )) {
    const f = fixture();
    await f.provision();
    const flow = await f.through("approve", "owner");
    await prepare?.(f, flow);
    const before = f.frozen();
    const below = await attempt(f, flow, f.fresh());
    expect([name, pair(below)]).toEqual([name, [400, "access_denied"]]);
    expect(f.frozen()).toBe(before);
    f.advance(60_000);
    const p = await previewed(f);
    await fill(f, "project", p, f.fresh(), () => post(f, p));
    const [full, limits] = [f.frozen(), f.limits()];
    const refused = await attempt(f, flow, f.fresh());
    expect([name, pair(refused)]).toEqual([name, [429, "rate_limited"]]);
    expect([f.frozen(), f.limits()]).toEqual([full, limits]);
    expect(f.seen.verified).toHaveLength(name === "replayed state" ? 1 : 0);
  }
}, 30_000);

test("a bound callback after exhaustion still checks the Clerk proof and the owner", async () => {
  const cases = [
    ["forged", 401, "AUTH_INVALID"],
    ["expired", 401, "AUTH_INVALID"],
    ["wrong-audience", 401, "AUTH_INVALID"],
    ["other-subject", 403, "AUTH_FORBIDDEN"],
    ["other-issuer", 403, "AUTH_FORBIDDEN"],
  ] as const;
  for (const [proof, status, word] of cases) {
    const f = fixture();
    await f.provision();
    const flow = await f.through("approve", proof);
    f.advance(60_000);
    const p = await previewed(f);
    await fill(f, "project", p, f.fresh(), () => post(f, p));
    const spent = f.limits();
    expect([proof, pair(await flow.done())]).toEqual([proof, [status, word]]);
    expect(f.limits()).toEqual(spent);
    // The state was used up: a replay is a guess, refused by the full budget.
    expect(pair(await flow.done())).toEqual([429, "rate_limited"]);
    expect(f.seen.verified).toHaveLength(1);
    expect(await f.pending(flow.login)).toEqual([400, "authorization_pending"]);
    expect(f.tokens()).toBe(1);
  }
}, 30_000);

test("one right ticket and one right state each complete once when used together under full budgets", async () => {
  for (const action of ACTIONS) {
    const f = fixture();
    await f.provision();
    const p = await previewed(f);
    await fill(f, "project", p, f.fresh(), () => post(f, p));
    const ticket = p.ticket(action);
    const posts = await together([
      () => post(f, p, { action, ticket }),
      () => post(f, p, { action, ticket }),
    ]);
    expect(posts.map(pair).sort()).toEqual([
      [302, ""],
      [429, "rate_limited"],
    ]);
    expect(f.seen.begun).toHaveLength(1);
    const decision = posts.find((reply) => reply.status === 302)!;
    const calls = await together([
      () => finish(f, decision),
      () => finish(f, decision),
    ]);
    expect(calls.map(pair).sort()).toEqual([
      [200, finished(action)],
      [429, "rate_limited"],
    ]);
    expect([f.seen.verified.length, f.claims.size]).toEqual([1, 1]);
    const first = await f.poll(p.login.device_code);
    expect([first.status, (await f.poll(p.login.device_code)).status]).toEqual(
      action === "approve" ? [200, 400] : [400, 400],
    );
    expect(f.tokens()).toBe(action === "approve" ? 2 : 1);
  }
}, 30_000);

test("a bound proof needs no window reset, and refused guesses never move the reset", async () => {
  const f = fixture();
  await f.provision();
  const p = await previewed(f);
  await fill(f, "challenge", p, f.fresh(), () => post(f, p));
  const spent = f.limits();
  f.advance(59_999);
  expect(pair(await post(f, p))).toEqual([429, "rate_limited"]);
  const decision = await right(f, p);
  expect(decision.status).toBe(302);
  expect(f.limits()).toEqual(spent);
  expect(pair(await finish(f, decision))).toEqual([200, "approved"]);
  expect(f.limits()).toEqual(spent);
  f.advance(1);
  expect(pair(await post(f, p))).toEqual([400, "invalid_request"]);
}, 30_000);

test("other address headers cannot escape the address cap, and a bound callback still needs the address", async () => {
  const f = fixture();
  await f.provision();
  const p = await previewed(f);
  const flow = await f.through("approve", "owner");
  const before = [f.frozen(), f.limits()];
  for (const ip of [null, ""])
    expect(pair(await f.callback(flow.state, "owner", flow.bind, ip))).toEqual([
      403,
      "AUTH_FORBIDDEN",
    ]);
  expect([f.frozen(), f.limits()]).toEqual(before);
  const x = f.fresh();
  const rotate = (n: number) =>
    f.send("/device/approve", {
      form: { csrf: p.jar.csrf, ticket: WRONG, challenge: "" },
      cookie: p.jar.cookie,
      ip: x,
      headers: {
        "X-Forwarded-For": `203.0.113.${n}`,
        "x-real-ip": `203.0.113.${n + 100}`,
      },
    });
  for (let n = 0; n < 5; n++)
    expect(pair(await rotate(n))).toEqual([400, "invalid_request"]);
  expect(pair(await rotate(9))).toEqual([429, "rate_limited"]);
}, 30_000);
