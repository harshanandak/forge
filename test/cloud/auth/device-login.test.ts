import { expect, test } from "bun:test";
import {
  createDeviceLogin,
  type ChallengeState,
  type ChallengeStore,
} from "../../../cloud/src/auth/device-login.ts";
import type { VerifiedIdentity } from "../../../src/ports/identity.ts";
import { testIdentityVerifier } from "../../contract/lib/identity-verifier.ts";

const sentinel = "upstream-credential-must-never-escape";
const device = { label: "laptop" };
function refused(value: unknown, error: string, interval?: number) {
  expect(value).toEqual({
    ok: false,
    error,
    ...(interval === undefined ? {} : { interval }),
  });
}
async function fixture() {
  let now = 1_000,
    sequence = 0;
  const state: ChallengeState = { challenges: [], attempts: 0, resetAt: 0 };
  const store: ChallengeStore = {
    transaction: (operation) => operation(state),
  };
  const calls: unknown[] = [];
  const claims = {
    issuer: "https://id.example",
    subject: "Human-A",
    audience: "forge",
    expiresAt: 1_000_000,
    authenticatedAt: 500,
    providerCredential: sentinel,
  };
  const verified = await testIdentityVerifier(
    new Map([[sentinel, claims]]),
  ).verify(sentinel, "forge", now);
  if (!verified.ok) throw new Error("Fixture identity refused");
  const options = {
    store,
    now: () => now,
    random: (length: number) =>
      Uint8Array.from({ length }, () => ++sequence % 256),
    issue: (identity: VerifiedIdentity, info: typeof device) => {
      calls.push({ identity, info });
      return Promise.resolve("forge-device-credential");
    },
  };
  return {
    login: createDeviceLogin(options),
    options,
    state,
    calls,
    identity: verified.identity,
    advance: (seconds: number) => {
      now += seconds * 1_000;
    },
  };
}

test("start returns distinct secret codes and an unambiguous human code stored only as hashes", async () => {
  const f = await fixture(),
    a = await f.login.start(device),
    b = await f.login.start(device);
  expect(a.device_code).toMatch(/^[A-Za-z0-9_-]{43,}$/);
  expect(a.user_code).toMatch(
    /^[BCDFGHJKLMNPQRSTVWXYZ]{4}-[BCDFGHJKLMNPQRSTVWXYZ]{4}$/,
  );
  expect(a.device_code).not.toBe(b.device_code);
  expect(a.user_code).not.toBe(b.user_code);
  expect(a.expires_in).toBeGreaterThan(0);
  expect(a.interval).toBe(5);
  expect(f.state.challenges).toHaveLength(2);
  for (const [index, challenge] of [a, b].entries()) {
    const record = f.state.challenges[index]!;
    for (const [raw, digest] of [
      [challenge.device_code, record.deviceHash],
      [challenge.user_code, record.userHash],
    ]) {
      const hash = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(raw),
      );
      expect(digest).toBe(
        Array.from(new Uint8Array(hash), (n) =>
          n.toString(16).padStart(2, "0"),
        ).join(""),
      );
      expect(JSON.stringify(f.state)).not.toContain(raw!);
    }
  }
}, 1_000);
test("explicit approval binds the human and initiating device before one redemption", async () => {
  const f = await fixture(),
    challenge = await f.login.start(device);
  refused(await f.login.poll(challenge.device_code), "authorization_pending");
  expect(f.calls).toHaveLength(0);
  expect(await f.login.approve(challenge.user_code, f.identity)).toEqual({
    ok: true,
  });
  f.advance(challenge.interval);
  expect(await f.login.poll(challenge.device_code)).toEqual({
    ok: true,
    credential: "forge-device-credential",
  });
  expect(f.calls).toEqual([
    {
      identity: {
        issuer: f.identity.issuer,
        subject: f.identity.subject,
        audience: f.identity.audience,
        expiresAt: f.identity.expiresAt,
        authenticatedAt: f.identity.authenticatedAt,
      },
      info: device,
    },
  ]);
  refused(await f.login.poll(challenge.device_code), "invalid_grant");
  refused(
    await f.login.approve(challenge.user_code, f.identity),
    "invalid_user_code",
  );
  expect(f.calls).toHaveLength(1);
}, 1_000);
test("early polling increases the interval by five seconds and keeps approval gated", async () => {
  const f = await fixture(),
    c = await f.login.start(device);
  refused(await f.login.poll(c.device_code), "authorization_pending");
  refused(await f.login.poll(c.device_code), "slow_down", c.interval + 5);
  f.advance(c.interval);
  refused(await f.login.poll(c.device_code), "slow_down", c.interval + 10);
  f.advance(c.interval + 10);
  refused(await f.login.poll(c.device_code), "authorization_pending");
  expect(f.calls).toHaveLength(0);
}, 1_000);
test("expiry at the exact boundary refuses both pending approval and approved redemption", async () => {
  const f = await fixture(),
    pending = await f.login.start(device),
    approved = await f.login.start(device);
  expect(await f.login.approve(approved.user_code, f.identity)).toEqual({
    ok: true,
  });
  f.advance(pending.expires_in);
  refused(
    await f.login.approve(pending.user_code, f.identity),
    "expired_token",
  );
  for (const c of [pending, approved])
    refused(await f.login.poll(c.device_code), "expired_token");
  expect(f.calls).toHaveLength(0);
}, 1_000);
test("denial cannot be changed into approval or redeemed", async () => {
  const f = await fixture(),
    c = await f.login.start(device);
  expect(await f.login.deny(c.user_code, f.identity)).toEqual({ ok: true });
  refused(await f.login.approve(c.user_code, f.identity), "invalid_user_code");
  refused(await f.login.poll(c.device_code), "access_denied");
  expect(f.calls).toHaveLength(0);
}, 1_000);
test("another device code cannot redeem an approved challenge", async () => {
  const f = await fixture(),
    a = await f.login.start(device),
    b = await f.login.start({ label: "other" });
  expect(await f.login.approve(a.user_code, f.identity)).toEqual({ ok: true });
  refused(await f.login.poll(b.device_code), "authorization_pending");
  refused(await f.login.poll("unknown-device"), "invalid_grant");
  expect(f.calls).toHaveLength(0);
  expect(await f.login.poll(a.device_code)).toEqual({
    ok: true,
    credential: "forge-device-credential",
  });
  expect(f.calls).toHaveLength(1);
}, 1_000);
test("five wrong human codes trigger a bounded shared rate limit across service instances", async () => {
  const f = await fixture(),
    c = await f.login.start(device);
  for (let i = 0; i < 5; i++)
    refused(
      await f.login.approve("WRNG-CODE", f.identity),
      "invalid_user_code",
    );
  const other = createDeviceLogin(f.options);
  refused(await other.approve(c.user_code, f.identity), "rate_limited");
  refused(await other.deny("WRNG-CODE", f.identity), "rate_limited");
  f.advance(60);
  expect(await other.approve(c.user_code, f.identity)).toEqual({ ok: true });
  expect(f.calls).toHaveLength(0);
}, 1_000);
test("concurrent polls across instances call issuance once and never expose upstream credentials", async () => {
  const f = await fixture(),
    c = await f.login.start(device);
  expect(await f.login.approve(c.user_code, f.identity)).toEqual({ ok: true });
  const results = await Promise.all([
    f.login.poll(c.device_code),
    createDeviceLogin(f.options).poll(c.device_code),
  ]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(results).toContainEqual({ ok: false, error: "invalid_grant" });
  expect(f.calls).toHaveLength(1);
  const errors = [
    await f.login.poll(sentinel),
    await f.login.approve(sentinel, f.identity),
  ];
  for (const value of [c, results, errors, f.state, f.calls])
    expect(JSON.stringify(value)).not.toContain(sentinel);
}, 1_000);
test("an issuance failure is typed, hides upstream errors and cannot issue again", async () => {
  const f = await fixture();
  const login = createDeviceLogin({
    ...f.options,
    issue: () => {
      f.calls.push("attempt");
      return Promise.reject(new Error(sentinel));
    },
  });
  const c = await login.start(device);
  expect(await login.approve(c.user_code, f.identity)).toEqual({ ok: true });
  refused(await login.poll(c.device_code), "issuance_failed");
  refused(await login.poll(c.device_code), "invalid_grant");
  expect(f.calls).toEqual(["attempt"]);
  expect(JSON.stringify(f.state)).not.toContain(sentinel);
}, 1_000);
