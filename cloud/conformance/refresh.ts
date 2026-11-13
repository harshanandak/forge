import assert from "node:assert/strict";
import { AssertionError } from "node:assert";
import {
  access,
  base,
  issue,
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
  assert(
    tokens.access_token && tokens.refresh_token,
    "refresh must return a full token pair",
  );
  assert.notEqual(
    tokens.refresh_token,
    family.refresh_token,
    "refresh must rotate its token",
  );
  assert.equal(
    tokens.expires_in,
    3600,
    "refresh access lifetime must be explicit seconds",
  );
  const next = { client: family.client, ...tokens };
  await access(next, true);
  return next;
}
async function refused(
  response: Response,
  error = "invalid_grant",
  status = 400,
) {
  assert.equal(
    response.status,
    status,
    "refresh refusal must use its exact status",
  );
  assert.deepEqual(
    await response.json(),
    { error },
    "refresh failure must be sanitized without token fields",
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
}
async function main() {
  const original = await issue("mcp:read mcp:write"),
    unrelated = await issue();
  await access(original, true);
  const first = await rotate(original);
  assert.equal(
    original.expires_in,
    3600,
    "code exchange access lifetime must be explicit seconds",
  );
  for (const fields of [
    { client_id: unrelated.client },
    { resource: "https://wrong.example" },
    { scope: "ungranted" },
    { refresh_token: first.refresh_token.replace(/:[^:]+$/, ":guessed") },
  ]) {
    await refused(await refresh(first, fields));
    await access(first, true);
  }
  const next = await rotate(first, { scope: "mcp:read", resource: base });
  assert.equal(next.scope, "mcp:read", "valid refresh may downscope");
  await refused(
    await refresh(next, {}, { "x-oauth-state-fault": "stub" }),
    "temporarily_unavailable",
    503,
  );
  await access(next, true);
  const newest = await rotate(next, { scope: "mcp:read" });
  await refused(await refresh(original));
  for (const family of [original, first, next, newest])
    await access(family, false);
  await refused(await refresh(newest));
  await access(unrelated, true);
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
  console.log(
    "PASS OAuth single refresh, scope/client/resource binding, old-token reuse, whole-grant revoke and state failure",
  );
}
await main().catch((error: unknown) => {
  console.error(
    `FAIL OAuth refresh: ${error instanceof AssertionError ? error.message.split("\n")[0] : "fixture unavailable"}`,
  );
  process.exitCode = 1;
});
