import { expect, mock, test } from "bun:test";
import { createOAuthHarness } from "../../adapters/workers-oauth/harness.ts";
import type { GrantStorage } from "../../../cloud/src/adapters/workers-oauth/grant-state.ts";
import { sha256 } from "../../../cloud/src/tokens.ts";
await mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
const { GrantState, durableGrants } =
  await import("../../../cloud/src/adapters/workers-oauth/grant-state.ts");
const { composeOAuth } =
  await import("../../../cloud/src/adapters/workers-oauth/compose.ts");
const { createOAuthAdapter, grantHash } =
  await import("../../../cloud/src/adapters/workers-oauth/index.ts");

async function revokeFixture(
  patch: Record<string, unknown> = {},
  failure = false,
) {
  const f = createOAuthHarness(),
    adapter = createOAuthAdapter(f.options);
  const client = await adapter.register("https://client.example/callback"),
    token = "user:grant:issued-secret",
    hash = await sha256(token);
  const revoke = mock(() =>
    failure ? Promise.reject(new Error("private failure")) : Promise.resolve(),
  );
  f.options.grantRevocation = { isActive: () => Promise.resolve(true), revoke };
  await f.options.storage.put(
    "grant:user:grant",
    JSON.stringify({
      id: "grant",
      userId: "user",
      clientId: client,
      expiresAt: 2000,
      refreshTokenId: hash,
      ...patch,
      ...(patch.previousRefreshTokenId ? { previousRefreshTokenId: hash } : {}),
      ...(patch.authCodeId ? { authCodeId: hash } : {}),
    }),
  );
  const auth = composeOAuth(f.options, f.options.resources[0]!);
  const send = (clientId = client, hint = "access_token") =>
    auth.route(
      new Request("https://auth.example/oauth/revoke", {
        method: "POST",
        body: new URLSearchParams({
          token,
          client_id: clientId,
          token_type_hint: hint,
        }),
      }),
    );
  return { ...f, client, token, revoke, send };
}

for (const fault of ["none", "read", "write", "stub"] as const) {
  test(`durable grant state is monotonic and fail-closed: ${fault}`, async () => {
    const values = new Map<string, unknown>(),
      hash = "a".repeat(64),
      names: string[] = [];
    const storage: GrantStorage = {
      get: <T>(key: string) =>
        fault === "read"
          ? Promise.reject(new Error("private"))
          : Promise.resolve(values.get(key) as T | undefined),
      put: (key, value) => {
        if (fault === "write") return Promise.reject(new Error("private"));
        values.set(key, value);
        return Promise.resolve();
      },
      transaction: (operation) => operation(storage),
    };
    const port = durableGrants({
      idFromName: (name) => {
        names.push(name);
        return name;
      },
      get: () => ({
        fetch: (request) =>
          fault === "stub"
            ? Promise.reject(new Error("private"))
            : new GrantState({ storage }).fetch(request),
      }),
    });
    if (fault === "read" || fault === "stub")
      await expect(port.isActive(hash)).rejects.toThrow(
        "Grant state unavailable",
      );
    else expect(await port.isActive(hash)).toBe(true);
    if (fault === "write" || fault === "stub")
      await expect(port.revoke(hash)).rejects.toThrow();
    else {
      await port.revoke(hash);
      await port.revoke(hash);
      expect(values.get("revoked")).toBe(true);
      if (fault === "none") expect(await port.isActive(hash)).toBe(false);
    }
    expect(names.every((name) => name === hash)).toBe(true);
    expect([...values.keys()].every((key) => key === "revoked")).toBe(true);
  }, 30_000);
}

for (const [name, patch, expected] of [
  ["current", {}, true],
  [
    "previous",
    { refreshTokenId: "other", previousRefreshTokenId: "full-hash" },
    true,
  ],
  ["expired", { expiresAt: 1 }, false],
  ["no deadline", { expiresAt: undefined }, false],
  ["overflow deadline", { expiresAt: 1e308 }, false],
  ["wrong client", { clientId: "other" }, false],
  ["wrong user", { userId: "other" }, false],
  ["wrong grant", { id: "other" }, false],
  ["guessed", { refreshTokenId: "other" }, false],
  [
    "authorization code",
    { refreshTokenId: undefined, authCodeId: "full-hash" },
    false,
  ],
] as const) {
  test(`holder refresh proof: ${name}`, async () => {
    const { send, revoke, token } = await revokeFixture(patch);
    const response = await send();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(revoke).toHaveBeenCalledTimes(expected ? 1 : 0);
    if (expected)
      expect(revoke).toHaveBeenCalledWith(await grantHash(token, "user"));
    expect(await grantHash(token, "other")).toBeNull();
  }, 30_000);
}

for (const mode of ["unknown", "confidential", "write-failure"] as const) {
  test(`holder revoke client and state refusal: ${mode}`, async () => {
    const f = await revokeFixture({}, true),
      { client, revoke } = f;
    if (mode === "confidential")
      await f.options.storage.put(
        `client:${client}`,
        JSON.stringify({
          clientId: client,
          tokenEndpointAuthMethod: "client_secret_basic",
        }),
      );
    const response = await f.send(
      mode === "unknown" ? "unknown" : client,
      "refresh_token",
    );
    expect(response.status).toBe(mode === "write-failure" ? 503 : 400);
    expect(await response.json()).toEqual({
      error:
        mode === "write-failure" ? "temporarily_unavailable" : "invalid_client",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(revoke).toHaveBeenCalledTimes(mode === "write-failure" ? 1 : 0);
  }, 30_000);
}

for (const [name, method, body, headers] of [
  ["GET", "GET", undefined, {}],
  ["non-form", "POST", "{}", { "Content-Type": "application/json" }],
  ["missing token", "POST", "client_id=client", {}],
  ["empty token", "POST", "token=&client_id=client", {}],
  ["duplicate token", "POST", "token=a&token=b&client_id=client", {}],
  ["duplicate client", "POST", "token=a&client_id=a&client_id=b", {}],
  [
    "duplicate hint",
    "POST",
    "token=a&client_id=a&token_type_hint=a&token_type_hint=b",
    {},
  ],
  ["secret", "POST", "token=a&client_id=a&client_secret=secret", {}],
  ["assertion", "POST", "token=a&client_id=a&client_assertion=proof", {}],
  [
    "assertion type",
    "POST",
    "token=a&client_id=a&client_assertion_type=jwt",
    {},
  ],
  [
    "header auth",
    "POST",
    "token=a&client_id=a",
    { Authorization: "Basic fixture" },
  ],
  ["oversize", "POST", `token=${"x".repeat(8192)}&client_id=a`, {}],
] as const) {
  test(`holder revoke refuses ${name}`, async () => {
    const f = createOAuthHarness();
    const auth = composeOAuth(f.options, f.options.resources[0]!);
    const response = await auth.route(
      new Request("https://auth.example/oauth/revoke", {
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
