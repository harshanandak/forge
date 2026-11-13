import { expect, mock, test } from "bun:test";
import { createOAuthHarness } from "../../adapters/workers-oauth/harness.ts";
import { sha256 } from "../../../cloud/src/tokens.ts";
await mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
const { createOAuthAdapter, grantHash } =
  await import("../../../cloud/src/adapters/workers-oauth/index.ts");

for (const remaining of [
  NaN,
  Infinity,
  59999,
  60000,
  60000.5,
  2592030000,
  2592030001,
  1e20,
]) {
  test(`refresh deadline boundary ${remaining}`, async () => {
    const f = createOAuthHarness(),
      hash = "a".repeat(64),
      token = "b".repeat(64),
      client = "c".repeat(64);
    expect(
      await f.options.grantRevocation.claim!(
        hash,
        token,
        client,
        f.options.clock.now() + remaining,
        true,
      ),
    ).toBe(remaining === 60000 || remaining === 2592030000 ? "won" : "refused");
  }, 30_000);
}
for (const revoke of [false, true]) {
  test(`refresh pinned horizon, early alarm, cleanup and immutable closure (${revoke})`, async () => {
    const f = createOAuthHarness(),
      hash = "a".repeat(64),
      token = "b".repeat(64),
      client = "c".repeat(64),
      deadline = f.options.clock.now() + 120000,
      port = f.options.grantRevocation;
    expect(await port.claim!(hash, token, client, deadline, true)).toBe("won");
    expect(
      await port.claim!(hash, "d".repeat(64), client, deadline + 1000, true),
    ).toBe("refused");
    expect(
      await port.claim!(hash, "d".repeat(64), client, deadline, false),
    ).toBe("refused");
    expect(
      await port.claim!(hash, token, "e".repeat(64), deadline, false),
    ).toBe("refused");
    expect(await port.isActive(hash)).toBe(true);
    if (revoke) {
      const result = await Promise.all([
        port.claim!(hash, "d".repeat(64), client, deadline, true),
        port.claim!(hash, "d".repeat(64), client, deadline, true),
      ]);
      expect(result.sort()).toEqual(["reused", "won"]);
    }
    f.advance(1000);
    await f.grantObject(hash).alarm();
    expect(f.grantAlarms.get(hash)).toBe(deadline + 30000);
    expect(await port.spent!(hash, token, client)).toBe(true);
    f.advance(deadline + 30000 - f.options.clock.now());
    await f.grantObject(hash).alarm();
    expect(await port.spent!(hash, token, client)).toBe(false);
    expect(await port.isActive(hash)).toBe(false);
    expect(
      await port.claim!(
        hash,
        token,
        client,
        f.options.clock.now() + 120000,
        true,
      ),
    ).toBe("refused");
  }, 30_000);
}

for (const [name, patch, error] of [
  ["unknown client", { client_id: "other" }, "invalid_client"],
  ["wrong resource", { resource: "https://wrong.example" }, "invalid_grant"],
  ["ungranted scope", { scope: "ungranted" }, "invalid_grant"],
  ["invalid scope separator", { scope: "mcp:read\tmcp:read" }, "invalid_grant"],
  ["guessed secret", { refresh_token: "user:grant:guessed" }, "invalid_grant"],
  ["bare grant", { refresh_token: "user:grant" }, "invalid_grant"],
  [
    "previous without ledger",
    { refresh_token: "user:grant:previous" },
    "invalid_grant",
  ],
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
        previousRefreshTokenId: await sha256("user:grant:previous"),
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
const basic = "grant_type=refresh_token&refresh_token=x&client_id=c";
for (const [name, body, headers, method] of [
  ["duplicate grant", `${basic}&grant_type=refresh_token`, {}, "POST"],
  ["duplicate token", `${basic}&refresh_token=y`, {}, "POST"],
  ["duplicate client", `${basic}&client_id=d`, {}, "POST"],
  ["duplicate resource", `${basic}&resource=a&resource=b`, {}, "POST"],
  ["duplicate scope", `${basic}&scope=a&scope=b`, {}, "POST"],
  ["missing token", "grant_type=refresh_token&client_id=c", {}, "POST"],
  ["missing client", "grant_type=refresh_token&refresh_token=x", {}, "POST"],
  ["missing grant", "refresh_token=x&client_id=c", {}, "POST"],
  ["empty grant", "grant_type=&refresh_token=x&client_id=c", {}, "POST"],
  ["empty client", `${basic.replace("client_id=c", "client_id=")}`, {}, "POST"],
  [
    "empty token",
    "grant_type=refresh_token&refresh_token=&client_id=c",
    {},
    "POST",
  ],
  ["secret auth", `${basic}&client_secret=x`, {}, "POST"],
  ["assertion auth", `${basic}&client_assertion=x`, {}, "POST"],
  ["assertion type", `${basic}&client_assertion_type=x`, {}, "POST"],
  ["header auth", basic, { Authorization: "Basic fixture" }, "POST"],
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
