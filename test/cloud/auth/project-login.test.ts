import { expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createDeviceLogin } from "../../../cloud/src/auth/device-login.ts";
import {
  importLoginKey,
  LOGIN_TTL_MS,
  loginStore,
} from "../../../cloud/src/auth/project-login.ts";
import { Project } from "../../../cloud/src/project.ts";
import { durableStore, type DurableStorage } from "../../../cloud/src/store.ts";
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
const KEY = Buffer.alloc(32, 7).toString("base64url");
const vars: Record<string, string> = {
  FORGE_CLOUD_PROJECT: "p",
  DEVICE_LOGIN_HMAC_KEY: KEY,
  CLERK_ISSUER: "https://clerk.example",
  FORGE_OWNER_SUBJECT: "user_Owner1",
  CLERK_CLIENT_ID: "client",
  ADMIN_TOKEN: "admin-secret",
};
const challenge = /^[A-Za-z0-9_-]{43}$/;
interface Body {
  ok?: boolean;
  error?: string | { code: string };
  interval?: number;
  device_code: string;
  user_code: string;
  credential: string;
  value?: unknown;
}
type Row = Record<string, unknown>;
interface Credential {
  id: string;
  token: string;
}
const err = (result: { body: Body }) =>
  typeof result.body.error === "object"
    ? result.body.error.code
    : result.body.error;
const credentialOf = (result: { body: Body }) =>
  JSON.parse(result.body.credential) as Credential;
type Fetcher = { fetch: (request: Request, env: never) => Promise<Response> };

function fixture(env: Record<string, string> = vars) {
  let t = start;
  spyOn(Date, "now").mockImplementation(() => t);
  const db = new Database(":memory:"),
    values = new Map<string, unknown>();
  const storage: DurableStorage = {
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
  };
  const project = new Project({ storage }, env);
  const reached: unknown[] = [];
  const bindings = {
    ...env,
    PROJECTS: {
      idFromName: (name: string) => name,
      get: (id: unknown) => {
        reached.push(id);
        return project;
      },
    },
  };
  const rows = (sql: string) => db.query(sql).all() as Row[];
  async function send(
    route: string,
    input?: unknown,
    headers: Record<string, string> = { "CF-Connecting-IP": "203.0.113.1" },
    worker: Fetcher = createWorker(),
    name = "p",
  ) {
    const response = await worker.fetch(
      new Request(`https://w.example/p/${name}/${route}`, {
        method: input === undefined ? "GET" : "POST",
        headers,
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      }),
      bindings as never,
    );
    const text = await response.text();
    return {
      status: response.status,
      cache: response.headers.get("cache-control"),
      text,
      body: (text.startsWith("{") ? JSON.parse(text) : {}) as Body,
    };
  }
  const admin = { authorization: `Bearer ${env.ADMIN_TOKEN}` };
  const provision = async () =>
    (await send("devices", { device: "seed", ttlMs: day }, admin)).body
      .value as Credential;
  async function approve(
    userCode: string,
    claims: Partial<IdentityClaims> = {},
  ) {
    const c = {
      issuer: vars.CLERK_ISSUER!,
      subject: vars.FORGE_OWNER_SUBJECT!,
      audience: vars.CLERK_CLIENT_ID!,
      expiresAt: t + 3_600_000,
      authenticatedAt: t - 1_000,
      ...claims,
    };
    const verified = await testIdentityVerifier(new Map([["proof", c]])).verify(
      "proof",
      c.audience,
      t,
    );
    if (!verified.ok) throw new Error("Fixture identity refused");
    const engine = createDeviceLogin({
      store: loginStore(durableStore(storage)),
      userCodeKey: await importLoginKey(KEY),
      now: () => t,
      random: (n) => crypto.getRandomValues(new Uint8Array(n)),
      issue: () => Promise.resolve("unused"),
    });
    return engine.approve(userCode, verified.identity);
  }
  return {
    send,
    rows,
    reached,
    provision,
    approve,
    admin,
    begin: (device = "laptop-1", ip = "203.0.113.1") =>
      send("loginstart", { device }, { "CF-Connecting-IP": ip }),
    poll: (device_code: string) => send("loginpoll", { device_code }),
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    tokens: () =>
      Number(rows("SELECT COUNT(*) AS n FROM domain_cloud_tokens")[0]!.n),
  };
}

test("loginstart returns a challenge and stores only hashes", async () => {
  const f = fixture();
  await f.provision();
  const { status, cache, body, text } = await f.begin();
  expect([status, cache]).toEqual([200, "no-store"]);
  expect(body).toMatchObject({
    ok: true,
    expires_in: 600,
    interval: 5,
    verification_uri: "/device",
    project: "p",
    device: "laptop-1",
  });
  expect(body.device_code).toMatch(challenge);
  const stored = String(
    f.rows("SELECT state FROM domain_cloud_login")[0]!.state,
  );
  expect(
    (JSON.parse(stored) as { challenges: unknown[] }).challenges,
  ).toHaveLength(1);
  for (const raw of [body.device_code, body.user_code])
    expect(stored).not.toContain(raw);
  expect(text).not.toContain("fct_");
  expect(f.tokens()).toBe(1);
}, 30_000);

test("pending, early and expired polls return the engine errors", async () => {
  const f = fixture();
  await f.provision();
  const { body } = await f.begin();
  const pending = await f.poll(body.device_code);
  expect<unknown>([pending.status, pending.body]).toEqual([
    400,
    { ok: false, error: "authorization_pending" },
  ]);
  const early = await f.poll(body.device_code);
  expect<unknown>([early.status, early.body]).toEqual([
    400,
    { ok: false, error: "slow_down", interval: 10 },
  ]);
  f.advance(601_000);
  const late = await f.poll(body.device_code);
  expect([late.status, err(late)]).toEqual([400, "expired_token"]);
  expect(err(await f.poll("short"))).toBe("invalid_grant");
  expect(f.tokens()).toBe(1);
}, 30_000);

test("an approved challenge yields one 30 day credential and never a second", async () => {
  const f = fixture();
  const logs = [spyOn(console, "log"), spyOn(console, "error")];
  const seed = await f.provision();
  const { body } = await f.begin();
  expect((await f.approve(body.user_code)).ok).toBe(true);
  const [one, two] = await Promise.all([
    f.poll(body.device_code),
    f.poll(body.device_code),
  ]);
  expect([one.body.ok, two.body.ok].sort()).toEqual([false, true]);
  const won = one.body.ok ? one : two;
  expect([won.status, won.cache]).toEqual([200, "no-store"]);
  const credential = credentialOf(won);
  expect(credential).toMatchObject({
    format: "forge/device-credential/1",
    device: "laptop-1",
    expiresAt: new Date(start + LOGIN_TTL_MS).toISOString(),
  });
  expect(credential.token).toMatch(/^fct_[0-9a-f]{16}\./);
  const row = f.rows(
    `SELECT * FROM domain_cloud_tokens WHERE id='${credential.id}'`,
  )[0]!;
  expect([row.expires_at, row.device, row.session]).toEqual([
    start + LOGIN_TTL_MS,
    "laptop-1",
    null,
  ]);
  expect(LOGIN_TTL_MS).toBe(2_592_000_000);
  const replay = await f.poll(body.device_code);
  expect([replay.status, err(replay)]).toEqual([400, "invalid_grant"]);
  expect(f.tokens()).toBe(2);
  const held = await f.send("holder?subject=x", undefined, {
    authorization: `Bearer ${credential.token}`,
  });
  expect([held.status, held.body.value]).toEqual([200, null]);
  const seen = JSON.stringify(logs.flatMap((spy) => spy.mock.calls));
  for (const secret of [
    body.device_code,
    body.user_code,
    credential.token,
    seed.token,
  ])
    expect(seen).not.toContain(secret);
}, 30_000);

test("an approval that is not the owner's mints nothing", async () => {
  const f = fixture();
  await f.provision();
  // Each case advances the clock, so the short expiry is taken from the clock at the moment it is used.
  const variants: ((now: number) => Partial<IdentityClaims>)[] = [
    () => ({ subject: "user_Other" }),
    () => ({ issuer: "https://other.example" }),
    () => ({ audience: "other-client" }),
    (now) => ({ expiresAt: now + 1_000 }),
  ];
  for (const variant of variants) {
    const { body } = await f.begin();
    expect((await f.approve(body.user_code, variant(f.now()))).ok).toBe(true);
    f.advance(2_000);
    const result = await f.poll(body.device_code);
    expect<unknown>([result.status, result.body]).toEqual([
      500,
      { ok: false, error: "issuance_failed" },
    ]);
  }
  expect(f.tokens()).toBe(1);
}, 30_000);

test("a full pending store refuses a new start with capacity_exceeded", async () => {
  const f = fixture();
  await f.provision();
  const record = (n: number) => ({
    deviceHash: `d${n}`,
    userHash: `u${n}`,
    deviceInfo: { label: "x" },
    expiresAt: start + 600_000,
    interval: 5,
    nextPoll: start,
    status: "pending",
  });
  const state = JSON.stringify({
    challenges: Array.from({ length: 1_024 }, (_, n) => record(n)),
    attempts: {},
  });
  f.rows(
    `INSERT INTO domain_cloud_login (id, state) VALUES (1, '${state}') ON CONFLICT(id) DO UPDATE SET state=excluded.state`,
  );
  const full = await f.begin();
  expect<unknown>([full.status, full.body]).toEqual([
    429,
    { ok: false, error: "capacity_exceeded" },
  ]);
  const stored = JSON.parse(
    String(f.rows("SELECT state FROM domain_cloud_login")[0]!.state),
  ) as { challenges: unknown[] };
  expect(stored.challenges).toHaveLength(1_024);
}, 30_000);

test("starts are limited per address and per project in a 60 second window", async () => {
  const f = fixture();
  await f.provision();
  for (let n = 0; n < 5; n++) expect((await f.begin()).status).toBe(200);
  const sixth = await f.begin();
  expect([sixth.status, err(sixth)]).toEqual([429, "rate_limited"]);
  expect((await f.begin("laptop-1", "203.0.113.2")).status).toBe(200);
  f.advance(60_000);
  expect((await f.begin()).status).toBe(200);
  const none = await f.send("loginstart", { device: "laptop-1" }, {});
  expect([none.status, none.body.ok]).toEqual([403, false]);
  for (let n = 10; n < 39; n++) await f.begin("laptop-1", `198.51.100.${n}`);
  const over = await f.begin("laptop-1", "198.51.100.99");
  expect([over.status, err(over)]).toEqual([429, "rate_limited"]);
}, 30_000);

test("another project name never reaches an object", async () => {
  const f = fixture();
  const headers = { "CF-Connecting-IP": "203.0.113.1" };
  const other = await f.send(
    "loginstart",
    { device: "laptop-1" },
    headers,
    createWorker(),
    "other",
  );
  expect([other.status, err(other)]).toEqual([403, "AUTH_FORBIDDEN"]);
  const unset = fixture({ ...vars, FORGE_CLOUD_PROJECT: "" });
  expect((await unset.begin()).status).toBe(403);
  expect([f.reached, unset.reached]).toEqual([[], []]);
}, 30_000);

test("a missing HMAC key refuses only the two login routes", async () => {
  const rest = { ...vars };
  delete rest.DEVICE_LOGIN_HMAC_KEY;
  const f = fixture(rest);
  const seed = await f.provision();
  for (const route of ["loginstart", "loginpoll"]) {
    const refused = await f.send(route, {
      device: "laptop-1",
      device_code: "x",
    });
    expect([refused.status, err(refused)]).toEqual([
      503,
      "AUTH_CONFIG_UNAVAILABLE",
    ]);
  }
  const held = await f.send("holder?subject=x", undefined, {
    authorization: `Bearer ${seed.token}`,
  });
  const status = await f.send("status", undefined, f.admin);
  expect([held.status, status.status, status.body.value]).toEqual([
    200,
    200,
    { initialized: true },
  ]);
}, 30_000);

test("login is refused before any table exists, and a later restore works", async () => {
  const f = fixture();
  const refused = await f.begin();
  expect([refused.status, err(refused)]).toEqual([403, "AUTH_FORBIDDEN"]);
  expect(f.rows("SELECT name FROM sqlite_master")).toEqual([]);
  const dump = await f.send("dump", undefined, f.admin);
  const restore = await f.send("restore", dump.body.value, f.admin);
  expect(restore.status).toBe(200);
}, 30_000);

test("a dump after a login has no login data and no credential", async () => {
  const f = fixture();
  await f.provision();
  const before = await f.send("dump", undefined, f.admin);
  const { body } = await f.begin();
  await f.approve(body.user_code);
  const done = await f.poll(body.device_code);
  const after = await f.send("dump", undefined, f.admin);
  const tables = (r: { body: Body }) =>
    Object.keys((r.body.value as { tables: object }).tables);
  expect(tables(after)).toEqual(tables(before));
  const token = credentialOf(done).token;
  for (const secret of [
    "domain_cloud_login",
    "domain_cloud_tokens",
    body.device_code,
    token,
    credentialOf(done).id,
  ])
    expect(after.text).not.toContain(secret);
}, 30_000);

test("login input is validated and a bearer token does not divert it to OAuth", async () => {
  const f = fixture();
  await f.provision();
  const bad = await f.send("loginstart", { device: "a b" });
  expect([bad.status, err(bad)]).toEqual([400, "INPUT_INVALID"]);
  const big = await f.send("loginstart", { device: "x".repeat(9_000) });
  expect(big.status).toBe(400);
  const oauth = await f.send(
    "loginstart",
    { device: "laptop-1" },
    {
      authorization: "Bearer opaque-oauth-token",
      "CF-Connecting-IP": "203.0.113.1",
    },
    createConfiguredWorker(),
  );
  expect([oauth.status, oauth.body.ok]).toEqual([200, true]);
  expect((await f.send("loginapprove", { code: "x" })).status).toBe(401);
}, 30_000);
