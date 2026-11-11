import { expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Project } from "../../../cloud/src/project.ts";
import { durableStore, type DurableStorage } from "../../../cloud/src/store.ts";
import {
  createProjectLogin,
  projectChallengeStore,
} from "../../../cloud/src/auth/project-login.ts";
import type { DeviceChallenge } from "../../../cloud/src/auth/device-login.ts";
import type { IdentityClaims } from "../../../src/ports/identity.ts";
import { testIdentityVerifier } from "../../contract/lib/identity-verifier.ts";

if (!("timingSafeEqual" in crypto.subtle))
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    value: crypto.timingSafeEqual.bind(crypto),
  });
await mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
const { createConfiguredWorker } =
  await import("../../../cloud/src/adapters/workers-oauth/compose.ts");
const now = 1_800_000_000_000;
const vars = {
  FORGE_CLOUD_PROJECT: "admitted",
  DEVICE_LOGIN_HMAC_KEY: "fixture-only-key-with-at-least-32-bytes",
  CLERK_ISSUER: "https://identity.example",
  CLERK_CLIENT_ID: "forge-client",
  FORGE_OWNER_SUBJECT: "user_Owner",
};
type Challenge = DeviceChallenge & {
  verification_uri: string;
  project: string;
  device: string;
};
type Credential = {
  format: string;
  id: string;
  token: string;
  device: string;
  expiresAt: string;
};
const json = async <T>(response: Response): Promise<T> =>
  (await response.json()) as T;
function fixture(overrides: Record<string, unknown> = {}) {
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const db = new Database(":memory:");
  const values = new Map<string, unknown>();
  let failTokenInsert = false;
  const storage: DurableStorage = {
    sql: {
      exec: (sql, ...bindings) => {
        if (
          failTokenInsert &&
          sql.startsWith("INSERT INTO domain_cloud_tokens")
        )
          throw new Error("injected token insert failure");
        return {
          toArray: () =>
            db
              .query(sql)
              .all(
                ...bindings.map((value) =>
                  value instanceof ArrayBuffer ? new Uint8Array(value) : value,
                ),
              ) as Record<string, unknown>[],
        };
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
  const allocations: string[] = [];
  const env = {
    ...vars,
    ADMIN_TOKEN: "fixture-admin",
    ...overrides,
    PROJECTS: {
      idFromName: (name: string) => {
        allocations.push(name);
        return name;
      },
      get: () => ({ fetch: (request: Request) => project.fetch(request) }),
    },
  };
  let project = new Project({ storage }, env);
  const worker = createConfiguredWorker();
  const send = (
    route: string,
    input?: unknown,
    headers: Record<string, string> = {},
    name = "admitted",
  ) =>
    worker.fetch(
      new Request(`https://cloud.example/p/${name}/${route}`, {
        method: input === undefined ? "GET" : "POST",
        headers: { "CF-Connecting-IP": "203.0.113.1", ...headers },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      }),
      env,
    );
  const admin = { authorization: "Bearer fixture-admin" };
  const provision = async () => {
    const response = await send(
      "devices",
      { device: "seed", ttlMs: 60_000 },
      admin,
    );
    expect(response.status).toBe(200);
    return (await json<{ value: Credential }>(response)).value;
  };
  const start = async (headers: Record<string, string> = {}) => {
    const response = await send("loginstart", { device: "laptop" }, headers);
    expect(response.status).toBe(200);
    return json<Challenge>(response);
  };
  const login = () => createProjectLogin(durableStore(storage), env);
  const identity = async (claims: Partial<IdentityClaims> = {}) => {
    const result = await testIdentityVerifier(
      new Map([
        [
          "proof",
          {
            issuer: vars.CLERK_ISSUER,
            subject: vars.FORGE_OWNER_SUBJECT,
            audience: vars.CLERK_CLIENT_ID,
            expiresAt: now + 900_000,
            authenticatedAt: now - 1_000,
            ...claims,
          },
        ],
      ]),
    ).verify("proof", claims.audience ?? vars.CLERK_CLIENT_ID, now);
    if (!result.ok) throw new Error("Fixture identity refused");
    return result.identity;
  };
  return {
    db,
    storage,
    allocations,
    send,
    admin,
    provision,
    start,
    login,
    identity,
    clock,
    failIssuance: () => {
      failTokenInsert = true;
    },
    restart: () => {
      project = new Project({ storage }, env);
    },
    [Symbol.dispose]: () => {
      db.close();
      clock.mockRestore();
    },
  };
}

test("public login starts without OAuth or bearer and survives project recreation", async () => {
  using f = fixture();
  await f.provision();
  const before = await (await f.send("dump", undefined, f.admin)).text();
  const c = await f.start({ authorization: "Bearer unrelated-oauth-token" });
  expect(c).toMatchObject({
    expires_in: 600,
    interval: 5,
    verification_uri: "/device",
    project: "admitted",
    device: "laptop",
  });
  expect(c.device_code).toMatch(/^[A-Za-z0-9_-]{43}$/);
  f.restart();
  const pending = await f.send("loginpoll", { device_code: c.device_code });
  expect(pending.status).toBe(400);
  expect(await json(pending)).toEqual({
    ok: false,
    error: "authorization_pending",
  });
  const early = await f.send("loginpoll", { device_code: c.device_code });
  expect(early.status).toBe(400);
  expect(await json(early)).toEqual({
    ok: false,
    error: "slow_down",
    interval: 10,
  });
  expect(await (await f.send("dump", undefined, f.admin)).text()).toBe(before);
}, 5_000);

test("wrong projects cannot allocate objects and missing login config preserves existing routes", async () => {
  using f = fixture({ DEVICE_LOGIN_HMAC_KEY: undefined });
  for (const route of ["loginstart", "loginpoll"]) {
    const wrong = await f.send(route, {}, {}, "other");
    expect(wrong.status).toBe(403);
    expect(await json(wrong)).toMatchObject({
      error: { code: "AUTH_FORBIDDEN" },
    });
  }
  expect(f.allocations).toEqual([]);
  const token = await f.provision();
  for (const route of ["loginstart", "loginpoll"]) {
    const unavailable = await f.send(route, {});
    expect(unavailable.status).toBe(503);
    expect(await json(unavailable)).toMatchObject({
      error: { code: "AUTH_CONFIG_UNAVAILABLE" },
    });
  }
  expect((await f.send("status", undefined, f.admin)).status).toBe(200);
  expect(
    (
      await f.send("holder?subject=issue", undefined, {
        authorization: `Bearer ${token.token}`,
      })
    ).status,
  ).toBe(200);
}, 5_000);

test("unprovisioned login leaves SQL empty and permits a subsequent restore", async () => {
  using f = fixture();
  const empty = await json<{ value: unknown }>(
    await f.send("dump", undefined, f.admin),
  );
  expect((await f.send("loginstart", { device: "laptop" })).status).toBe(400);
  expect(
    f.db.query("SELECT name FROM sqlite_schema WHERE type='table'").all(),
  ).toEqual([]);
  expect((await f.send("restore", empty.value, f.admin)).status).toBe(200);
}, 5_000);

test("approved racing polls issue one device credential with the fixed lifetime and private response", async () => {
  using f = fixture();
  await f.provision();
  const before = await (await f.send("dump", undefined, f.admin)).text();
  const c = await f.start();
  const engine = await f.login();
  expect(await engine.approve(c.user_code, await f.identity())).toEqual({
    ok: true,
  });
  const replies = await Promise.all([
    f.send("loginpoll", { device_code: c.device_code }),
    f.send("loginpoll", { device_code: c.device_code }),
  ]);
  expect(replies.map((r) => r.status).sort()).toEqual([200, 400]);
  const success = replies.find((r) => r.status === 200)!;
  expect(success.headers.get("Cache-Control")).toBe("no-store");
  const result = await json<{ ok: boolean; credential: string }>(success);
  expect(result.ok).toBe(true);
  const credential = JSON.parse(result.credential) as Credential;
  expect(credential).toMatchObject({
    format: "forge/device-credential/1",
    device: "laptop",
  });
  expect(Date.parse(credential.expiresAt) - now).toBe(2_592_000_000);
  expect(
    (
      await f.send("holder?subject=issue", undefined, {
        authorization: `Bearer ${credential.token}`,
      })
    ).status,
  ).toBe(200);
  expect(
    f.db
      .query(
        "SELECT device, session, agent, harness FROM domain_cloud_tokens WHERE id=?",
      )
      .get(credential.id),
  ).toEqual({ device: "laptop", session: null, agent: null, harness: null });
  const loser = replies.find((r) => r.status === 400)!;
  expect(await json(loser)).toEqual({ ok: false, error: "invalid_grant" });
  expect(
    f.db.query("SELECT count(*) AS n FROM domain_cloud_tokens").get(),
  ).toEqual({ n: 2 });
  const dump = await (await f.send("dump", undefined, f.admin)).text();
  expect(dump).toBe(before);
  for (const forbidden of [
    "domain_cloud_login",
    "domain_cloud_tokens",
    credential.token,
    c.device_code,
    c.user_code,
  ])
    expect(dump).not.toContain(forbidden);
  const rows = f.db.query("SELECT * FROM domain_cloud_login").all();
  expect(rows).toHaveLength(1);
  const persisted = JSON.stringify(rows);
  for (const forbidden of [
    credential.token,
    c.device_code,
    c.user_code,
    vars.DEVICE_LOGIN_HMAC_KEY,
  ])
    expect(persisted).not.toContain(forbidden);
}, 5_000);

test("poll rechecks approved owner claims and exact identity or challenge expiry before minting", async () => {
  for (const changed of [
    { issuer: "https://other.example" },
    { subject: "user_Other" },
    { audience: "another-client" },
    { expiresAt: now + 1_000 },
    {},
  ]) {
    using f = fixture();
    await f.provision();
    const c = await f.start();
    expect(
      await (await f.login()).approve(c.user_code, await f.identity(changed)),
    ).toEqual({ ok: true });
    f.clock.mockReturnValue(
      now + (Object.keys(changed).length === 0 ? 600_000 : 1_000),
    );
    const reply = await f.send("loginpoll", { device_code: c.device_code });
    expect(reply.status).toBe(400);
    expect(await json(reply)).toEqual({
      ok: false,
      error:
        Object.keys(changed).length === 0 ? "expired_token" : "issuance_failed",
    });
    expect(
      f.db.query("SELECT count(*) AS n FROM domain_cloud_tokens").get(),
    ).toEqual({ n: 1 });
  }
}, 5_000);

test("shared login updates roll back on throw and retain only bounded private state", async () => {
  using f = fixture();
  await f.provision();
  const first = projectChallengeStore(durableStore(f.storage));
  first.conditionalUpdate((state) => {
    state.attempts.saved = { failed: 1, resetAt: now + 60_000 };
  });
  const other = projectChallengeStore(durableStore(f.storage));
  expect(other.conditionalUpdate((state) => state.attempts.saved)).toEqual({
    failed: 1,
    resetAt: now + 60_000,
  });
  expect(() =>
    other.conditionalUpdate((state) => {
      delete state.attempts.saved;
      throw new Error("injected rollback");
    }),
  ).toThrow("injected rollback");
  expect(first.conditionalUpdate((state) => state.attempts.saved?.failed)).toBe(
    1,
  );
}, 5_000);

test("start admission bounds address and project work and refuses absent trusted addresses", async () => {
  using f = fixture();
  await f.provision();
  expect(
    (
      await f.send(
        "loginstart",
        { device: "laptop" },
        { "CF-Connecting-IP": "" },
      )
    ).status,
  ).toBe(403);
  for (let start = 0; start < 5; start++) await f.start();
  expect((await f.send("loginstart", { device: "laptop" })).status).toBe(429);
  for (let address = 2; address <= 6; address++)
    for (let start = 0; start < 5; start++)
      await f.start({ "CF-Connecting-IP": `203.0.113.${address}` });
  expect((await f.send("loginstart", { device: "laptop" })).status).toBe(429);
  expect(
    (
      await f.send(
        "loginstart",
        { device: "laptop" },
        { "CF-Connecting-IP": "203.0.113.7" },
      )
    ).status,
  ).toBe(429);
  f.clock.mockReturnValue(now + 60_000);
  await f.start();
}, 5_000);

test("login rejects malformed or oversized input and never accepts client approval claims", async () => {
  using f = fixture();
  await f.provision();
  for (const input of [
    { device: "" },
    { device: 42 },
    { device: "x".repeat(8_193) },
  ])
    expect((await f.send("loginstart", input)).status).toBe(400);
  const c = await f.start();
  const poll = await f.send("loginpoll", {
    device_code: c.device_code,
    identity: await f.identity(),
    approved: true,
  });
  expect(poll.status).toBe(400);
  expect(
    f.db.query("SELECT count(*) AS n FROM domain_cloud_tokens").get(),
  ).toEqual({ n: 1 });
}, 5_000);

test("failed issuance consumes the challenge and cannot mint on a retry", async () => {
  using f = fixture();
  await f.provision();
  const c = await f.start();
  expect(
    await (await f.login()).approve(c.user_code, await f.identity()),
  ).toEqual({ ok: true });
  f.failIssuance();
  const first = await f.send("loginpoll", { device_code: c.device_code });
  expect(first.status).toBe(400);
  expect(await json(first)).toEqual({ ok: false, error: "issuance_failed" });
  const retry = await f.send("loginpoll", { device_code: c.device_code });
  expect(retry.status).toBe(400);
  expect(await json(retry)).toEqual({ ok: false, error: "invalid_grant" });
  expect(
    f.db.query("SELECT count(*) AS n FROM domain_cloud_tokens").get(),
  ).toEqual({ n: 1 });
}, 5_000);

test("public routes retain the live challenge ceiling and cannot approve or access admin", async () => {
  using f = fixture();
  await f.provision();
  const engine = await f.login();
  const c = await engine.start({ label: "laptop" });
  const store = projectChallengeStore(durableStore(f.storage));
  store.conditionalUpdate((state) => {
    const row = state.challenges[0]!;
    state.challenges = Array.from({ length: 1_024 }, (_, i) => ({
      ...row,
      deviceHash: String(i),
      userHash: String(i),
    }));
  });
  const capacity = await f.send("loginstart", { device: "laptop" });
  expect(capacity.status).toBe(429);
  expect(await json(capacity)).toEqual({
    ok: false,
    error: "capacity_exceeded",
  });
  for (const route of [
    "devices",
    "revoke",
    "restore",
    "loginapprove",
    "logindeny",
  ])
    expect(
      (
        await f.send(
          route,
          {
            device: "attacker",
            ttlMs: 60_000,
            user_code: c.user_code,
            identity: await f.identity(),
          },
          { "X-Forge-Owner": "forged" },
        )
      ).status,
    ).toBeGreaterThanOrEqual(400);
  expect(
    f.db.query("SELECT count(*) AS n FROM domain_cloud_tokens").get(),
  ).toEqual({ n: 1 });
}, 5_000);
