import assert from "node:assert/strict";
import { AssertionError } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";

const base = "http://127.0.0.1:8788";
const state = process.env.OAUTH_CONFORMANCE_STATE;
assert(state, "OAUTH_CONFORMANCE_STATE is required");
const timeout = 10_000;
const send = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(timeout),
  });
const post = (path: string, fields: Record<string, string>) =>
  send(path, { method: "POST", body: new URLSearchParams(fields) });
interface Family {
  client: string;
  access_token: string;
  refresh_token: string;
}
async function issue(): Promise<Family> {
  const registered = await send("/fixture/register");
  assert.equal(registered.status, 200, "fixture registration must work");
  const { client } = (await registered.json()) as { client: string };
  const cookies = new Map<string, string>();
  async function browser(path: string, body?: Record<string, string>) {
    const response = await send(path, {
      headers: { cookie: [...cookies.values()].join("; ") },
      ...(body ? { method: "POST", body: new URLSearchParams(body) } : {}),
    });
    for (const cookie of response.headers.getSetCookie())
      cookies.set(cookie.split("=")[0]!, cookie.split(";")[0]!);
    return response;
  }
  const authorize = await browser(
    `/authorize?${new URLSearchParams({ response_type: "code", client_id: client, redirect_uri: "http://127.0.0.1:9999/callback", resource: base, state: "fixture", code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256" }).toString()}`,
  );
  assert.equal(authorize.status, 200, "fixture authorization must work");
  const handle = /name="handle" value="([^"]+)"/.exec(
    await authorize.text(),
  )?.[1];
  assert(handle, "fixture consent handle must exist");
  const consent = await browser("/authorize", { handle, allow: "true" });
  assert.equal(consent.status, 302, "fixture consent must work");
  const upstream = new URL(consent.headers.get("location")!);
  const callback = await browser(
    `/callback?state=${upstream.searchParams.get("state")}`,
  );
  assert.equal(callback.status, 302, "fixture callback must work");
  const code = new URL(callback.headers.get("location")!).searchParams.get(
    "code",
  );
  assert(code, "fixture code must exist");
  const response = await post("/oauth/token", {
    grant_type: "authorization_code",
    client_id: client,
    redirect_uri: "http://127.0.0.1:9999/callback",
    resource: base,
    code,
    code_verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  });
  assert.equal(
    response.status,
    200,
    "fixture code exchange must succeed before revoke assertions",
  );
  const tokens = (await response.json()) as Omit<Family, "client">;
  assert(
    tokens.access_token && tokens.refresh_token,
    "provider must issue both full tokens",
  );
  return { client, ...tokens };
}
async function access(family: Family, active: boolean) {
  const headers = { Authorization: `Bearer ${family.access_token}` };
  const verified = await send("/fixture/verify", { headers });
  assert.deepEqual(
    await verified.json(),
    { verified: active, accepts: active },
    "verification must reflect durable grant revocation",
  );
  assert.equal(
    (await send("/p/oauth/holder?subject=owner", { headers })).status,
    active ? 200 : 403,
    "owner access must reflect durable grant revocation",
  );
}
async function revoke(family: Family, token: string) {
  const response = await post("/oauth/revoke", {
    token,
    client_id: family.client,
  });
  assert.equal(response.status, 200, "explicit holder revoke must return 200");
  assert.equal(await response.text(), "", "revoke must return an empty body");
  assert.equal(
    response.headers.get("cache-control"),
    "no-store",
    "revoke must be no-store",
  );
}
async function main() {
  if (process.argv[2] === "restart") {
    const { revoked, unrelated } = JSON.parse(readFileSync(state!, "utf8")) as {
      revoked: Family[];
      unrelated: Family;
    };
    for (const family of revoked) await access(family, false);
    await access(unrelated, true);
    console.log("PASS OAuth revocation persists across workerd restart");
    return;
  }
  const unrelated = await issue(),
    revoked: Family[] = [];
  await access(unrelated, true);
  async function outages() {
    for (const fault of ["read", "write", "stub"]) {
      const headers = {
        "x-oauth-state-fault": fault,
        Authorization: `Bearer ${unrelated.access_token}`,
      };
      if (fault !== "write") {
        const response = await send("/fixture/verify", { headers });
        assert.deepEqual(
          await response.json(),
          { verified: false, accepts: false },
          "state read failure must refuse access",
        );
      }
      if (fault !== "read") {
        const response = await send("/oauth/revoke", {
          method: "POST",
          headers: { "x-oauth-state-fault": fault },
          body: new URLSearchParams({
            token: unrelated.access_token,
            client_id: unrelated.client,
          }),
        });
        assert.equal(
          response.status,
          503,
          "state write failure cannot claim a successful revoke",
        );
        assert.deepEqual(await response.json(), {
          error: "temporarily_unavailable",
        });
        assert.equal(response.headers.get("cache-control"), "no-store");
      }
      await access(unrelated, true);
    }
    console.log(
      "PASS OAuth state outage refuses without revoking the unrelated grant",
    );
  }
  for (const kind of ["access_token", "refresh_token"] as const) {
    const family = await issue();
    await access(family, true);
    const snapshot = await (await send("/fixture/snapshot")).text();
    for (const token of [
      "unknown",
      family[kind].replace(/:[^:]+$/, ":guessed"),
    ]) {
      await revoke(family, token);
      await access(family, true);
    }
    await revoke({ ...family, client: unrelated.client }, family[kind]);
    await access(family, true);
    await revoke(family, family[kind]);
    await access(family, false);
    await revoke(family, family[kind]);
    const restored = await send("/fixture/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: snapshot,
    });
    assert.equal(restored.status, 204, "stale KV fixture must restore");
    await access(family, false);
    await access(unrelated, true);
    const refresh = await post("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: family.refresh_token,
      client_id: family.client,
    });
    assert.equal(refresh.status, 400);
    assert.deepEqual(await refresh.json(), { error: "unsupported_grant_type" });
    revoked.push(family);
    console.log(
      `PASS OAuth ${kind} revoke refuses subsequent and stale-KV access`,
    );
  }
  await outages();
  writeFileSync(state!, JSON.stringify({ revoked, unrelated }), {
    mode: 0o600,
  });
}
await main().catch((error: unknown) => {
  console.error(
    `FAIL OAuth holder revocation: ${error instanceof AssertionError ? error.message.split("\n")[0] : "fixture unavailable"}`,
  );
  process.exitCode = 1;
});
