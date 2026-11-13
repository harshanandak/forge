import { expect, mock, test } from "bun:test";
import { createOAuthHarness } from "../../adapters/workers-oauth/harness.ts";
import { sha256 } from "../../../cloud/src/tokens.ts";
await mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
const { createOAuthAdapter, grantHash } =
  await import("../../../cloud/src/adapters/workers-oauth/index.ts");

for (const [name, patch, error] of [
  ["unknown client", { client_id: "other" }, "invalid_client"],
  ["wrong resource", { resource: "https://wrong.example" }, "invalid_grant"],
  ["ungranted scope", { scope: "ungranted" }, "invalid_grant"],
  ["guessed secret", { refresh_token: "user:grant:guessed" }, "invalid_grant"],
  ["bare grant", { refresh_token: "user:grant" }, "invalid_grant"],
] as const) {
  test(`refresh refuses ${name} before issuance`, async () => {
    const f = createOAuthHarness(),
      adapter = createOAuthAdapter(f.options);
    const token = "user:grant:issued-secret",
      client = await adapter.register("https://client.example/callback");
    await f.options.storage.put(
      "grant:user:grant",
      JSON.stringify({
        id: "grant",
        userId: "user",
        clientId: client,
        expiresAt: 2000,
        refreshTokenId: await sha256(token),
        resource: f.options.resources[0],
        scope: ["mcp:read"],
      }),
    );
    const write = mock(f.options.storage.put.bind(f.options.storage));
    f.options.storage.put = write;
    const response = await adapter.token(
      new Request("https://auth.example/oauth/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: token,
          client_id: client,
          ...patch,
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(write).not.toHaveBeenCalled();
    expect(
      await f.options.grantRevocation.isActive(
        (await grantHash(token, "user"))!,
      ),
    ).toBe(true);
  }, 30_000);
}
for (const [name, body, headers, method] of [
  [
    "duplicate grant",
    "grant_type=refresh_token&grant_type=refresh_token&refresh_token=x&client_id=c",
    {},
    "POST",
  ],
  [
    "duplicate token",
    "grant_type=refresh_token&refresh_token=x&refresh_token=y&client_id=c",
    {},
    "POST",
  ],
  [
    "duplicate client",
    "grant_type=refresh_token&refresh_token=x&client_id=c&client_id=d",
    {},
    "POST",
  ],
  [
    "duplicate resource",
    "grant_type=refresh_token&refresh_token=x&client_id=c&resource=a&resource=b",
    {},
    "POST",
  ],
  [
    "duplicate scope",
    "grant_type=refresh_token&refresh_token=x&client_id=c&scope=a&scope=b",
    {},
    "POST",
  ],
  ["missing token", "grant_type=refresh_token&client_id=c", {}, "POST"],
  ["missing client", "grant_type=refresh_token&refresh_token=x", {}, "POST"],
  [
    "empty token",
    "grant_type=refresh_token&refresh_token=&client_id=c",
    {},
    "POST",
  ],
  [
    "secret auth",
    "grant_type=refresh_token&refresh_token=x&client_id=c&client_secret=x",
    {},
    "POST",
  ],
  [
    "assertion auth",
    "grant_type=refresh_token&refresh_token=x&client_id=c&client_assertion=x",
    {},
    "POST",
  ],
  [
    "assertion type",
    "grant_type=refresh_token&refresh_token=x&client_id=c&client_assertion_type=x",
    {},
    "POST",
  ],
  [
    "header auth",
    "grant_type=refresh_token&refresh_token=x&client_id=c",
    { Authorization: "Basic fixture" },
    "POST",
  ],
  ["non-form", "{}", { "Content-Type": "application/json" }, "POST"],
  ["GET", undefined, {}, "GET"],
] as const) {
  test(`refresh refuses malformed ${name}`, async () => {
    const f = createOAuthHarness(),
      adapter = createOAuthAdapter(f.options);
    const response = await adapter.token(
      new Request("https://auth.example/oauth/token", {
        method,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          ...headers,
        },
        ...(body === undefined ? {} : { body }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  }, 30_000);
}
