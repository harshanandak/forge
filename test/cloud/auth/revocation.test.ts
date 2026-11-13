import { expect, mock, test } from "bun:test";
import { createOAuthHarness } from "../../adapters/workers-oauth/harness.ts";
await mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
const { composeOAuth } =
  await import("../../../cloud/src/adapters/workers-oauth/compose.ts");

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
