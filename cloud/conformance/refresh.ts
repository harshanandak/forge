import assert from "node:assert/strict";
import {
  access,
  base,
  detail,
  issue,
  mask,
  post,
  revoke,
  send,
  type Family,
} from "./oauth.ts";

const refresh = (
  family: Family,
  fields: Record<string, string> = {},
  headers?: RequestInit["headers"],
) =>
  send("/oauth/token", {
    method: "POST",
    ...(headers ? { headers } : {}),
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: family.client,
      refresh_token: family.refresh_token,
      ...fields,
    }),
  });
async function rotate(family: Family, fields: Record<string, string> = {}) {
  const response = await refresh(family, fields);
  assert.equal(response.status, 200, "eligible refresh must return 200");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const tokens = (await response.json()) as Omit<Family, "client">;
  mask(tokens);
  assert(
    tokens.access_token && tokens.refresh_token,
    "refresh must return a full token pair",
  );
  const rotated = tokens.refresh_token;
  assert.notEqual(rotated, family.refresh_token, "rotation required");
  assert.equal(tokens.expires_in, 3600, "access TTL in seconds");
  const next = { client: family.client, ...tokens };
  await access(next, true);
  return next;
}
async function refused(
  response: Response,
  error = "invalid_grant",
  status = 400,
) {
  assert.equal(response.status, status, `refresh refusal: ${error}`);
  assert.deepEqual(await response.json(), { error }, "sanitized refresh error");
  assert.equal(response.headers.get("cache-control"), "no-store");
}
async function main() {
  const original = await issue("mcp:read mcp:write"),
    unrelated = await issue();
  await access(original, true);
  const expiry = (family: Family, remaining: number | null, access = false) =>
    send("/fixture/refresh-expiry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: access ? family.access_token : family.refresh_token,
        remaining,
        access,
      }),
    });
  assert.equal((await expiry(original, -1, true)).status, 200, "expire access");
  await access(original, false);
  const snapshot = await (await send("/fixture/snapshot")).text();
  const first = await rotate(original);
  assert.equal(original.expires_in, 3600, "code access TTL in seconds");
  for (const fields of [
    { client_id: unrelated.client },
    { resource: "https://wrong.example" },
    { scope: "ungranted" },
    { scope: "mcp:read\tmcp:write" },
    { refresh_token: first.refresh_token.replace(/:[^:]+$/, ":guessed") },
  ]) {
    await refused(await refresh(first, fields));
    await access(first, true);
  }
  const next = await rotate(first, {
    scope: "mcp:read ungranted",
    resource: base,
  });
  assert.equal(next.scope, "mcp:read", "valid refresh may downscope");
  await refused(
    await refresh(next, {}, { "x-oauth-state-fault": "stub" }),
    "temporarily_unavailable",
    503,
  );
  await access(next, true);
  const newest = await rotate(next, { scope: "mcp:read" });
  const restored = await send("/fixture/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: snapshot,
  });
  assert.equal(restored.status, 204, "restore pre-rotation KV snapshot");
  await refused(await refresh(original));
  for (const family of [original, first, next, newest])
    await access(family, false);
  await refused(await refresh(newest));
  await access(unrelated, true);
  const spentHolder = await issue();
  let holder = spentHolder;
  for (let rotation = 0; rotation < 2; rotation++)
    holder = await rotate(holder);
  await revoke(spentHolder, spentHolder.refresh_token);
  await access(holder, false);
  await refused(await refresh(holder));
  for (const token of ["access_token", "refresh_token"] as const) {
    const explicit = await issue();
    await revoke(explicit, explicit[token]);
    await refused(await refresh(explicit));
    await access(explicit, false);
  }
  const native = await post("/oauth/token", {
    grant_type: "revoke",
    token: unrelated.access_token,
    client_id: unrelated.client,
  });
  await refused(native, "unsupported_grant_type");
  for (const [remaining, status] of [
    [null, 400],
    [-1, 400],
    [59, 400],
    [120, 200],
  ] as const) {
    const bounded = await issue();
    assert.equal((await expiry(bounded, remaining)).status, 200, "set expiry");
    const response = await refresh(bounded);
    if (status === 400) await refused(response);
    else {
      assert.equal(response.status, 200, "refresh within fixed grant expiry");
      const tokens = (await response.json()) as Omit<Family, "client">;
      mask(tokens);
      assert(
        tokens.expires_in >= 60 && tokens.expires_in <= 120,
        "access TTL must shorten at the fixed grant deadline",
      );
      await access({ client: bounded.client, ...tokens }, true);
    }
  }
  const expired = await issue();
  await refused(await refresh(expired, {}, { "x-refresh-clock": "7201000" }));
  await refused(await refresh(expired));
  await access(expired, false);
  console.log(
    "PASS OAuth single refresh, scope/client/resource binding, old-token reuse, whole-grant revoke and state failure",
  );
}
await main().catch((error: unknown) => {
  console.error(`FAIL OAuth refresh: ${detail(error)}`);
  process.exitCode = 1;
});
