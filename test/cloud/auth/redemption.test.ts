import { expect, mock, test } from "bun:test";
import type { ClaimStore } from "../../../cloud/src/adapters/workers-oauth/redemption.ts";
import { createOAuthHarness } from "../../adapters/workers-oauth/harness.ts";

await mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
const {
  CodeRedemption,
  durableRedemption,
  validateCodeBindings,
  codeExpiresAt,
  CODE_REPLAY_HORIZON_MS,
} = await import("../../../cloud/src/adapters/workers-oauth/redemption.ts");
const { createOAuthAdapter } =
  await import("../../../cloud/src/adapters/workers-oauth/index.ts");

const code = "person:grant:private-code",
  verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const digest = async (value: string) =>
  Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  ).toString("hex");
const form = (overrides: Record<string, string> = {}) => {
  const result = new FormData();
  for (const [key, value] of Object.entries({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: "public-client",
    redirect_uri: "https://client.example/callback",
    ...overrides,
  }))
    result.set(key, value);
  return result;
};
async function fixture() {
  const harness = createOAuthHarness(),
    hash = await digest(code);
  const grant = {
    createdAt: harness.options.clock.now() / 1_000,
    authCodeId: hash,
    clientId: "public-client",
    redirectUri: "https://client.example/callback",
    codeChallenge: Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ).toString("base64url"),
    codeChallengeMethod: "S256",
  };
  await harness.options.storage.put(
    "grant:person:grant",
    JSON.stringify(grant),
    { expirationTtl: 600 },
  );
  return { ...harness, grant, hash };
}
function durableFixture(now = Date.now()) {
  const values = new Map<string, number>(),
    names: string[] = [],
    payloads: string[] = [],
    responses: string[] = [];
  let tail = Promise.resolve();
  let alarm = 0;
  const store: ClaimStore = {
    get: <T>(key: string) => Promise.resolve(values.get(key) as T | undefined),
    put: (key, value) => {
      values.set(key, value);
      return Promise.resolve();
    },
    setAlarm: (at) => {
      alarm = at;
      return Promise.resolve();
    },
  };
  const storage = {
    ...store,
    deleteAll: () => {
      values.clear();
      return Promise.resolve();
    },
    transaction<T>(operation: (store: ClaimStore) => Promise<T>) {
      const result = tail.then(() => operation(store));
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
  const object = new CodeRedemption({ storage }, undefined, { now: () => now });
  const port = durableRedemption({
    idFromName: (name) => {
      names.push(name);
      return name;
    },
    get: () => ({
      fetch: async (request) => {
        payloads.push(await request.clone().text());
        const response = await object.fetch(request);
        responses.push(await response.clone().text());
        return response;
      },
    }),
  });
  const advance = () => {
    now = alarm;
  };
  return { object, port, values, names, payloads, responses, advance };
}

test("two concurrent durable claims have one winner and replay loses", async () => {
  const f = durableFixture(),
    hash = await digest(code),
    until = Date.now() + 600_000;
  const outcomes = await Promise.all([
    f.port.claimOnce(hash, until),
    f.port.claimOnce(hash, until),
  ]);
  expect(outcomes.filter(Boolean)).toHaveLength(1);
  expect(await f.port.claimOnce(hash, until)).toBe(false);
  expect(f.names).toEqual([hash, hash, hash]);
  expect(f.values.size).toBe(1);
  const replies = f.responses.map((body) => JSON.parse(body) as unknown);
  expect(replies).toContainEqual({ error: "invalid_grant" });
  const stored = JSON.stringify([...f.values]),
    sent = f.payloads.join(" ");
  for (const secret of [code, verifier, "private-token"]) {
    expect(stored).not.toContain(secret);
    expect(sent).not.toContain(secret);
    expect(f.responses.join(" ")).not.toContain(secret);
  }
}, 30_000);

test("alarm cleanup cannot revive a code after its issuance horizon", async () => {
  const f = await fixture(),
    d = durableFixture(f.options.clock.now() - 30_000);
  f.options.codeRedemption = d.port;
  const expiresAt = await codeExpiresAt(code, f.options.storage);
  expect(await d.port.claimOnce(f.hash, expiresAt)).toBe(true);
  f.advance(CODE_REPLAY_HORIZON_MS);
  d.advance();
  await d.object.alarm();
  expect(d.values.size).toBe(0);
  expect(await f.options.storage.get("grant:person:grant")).toBeNull();
  await f.options.storage.put("grant:person:grant", JSON.stringify(f.grant));
  expect(await f.options.storage.get("grant:person:grant")).not.toBeNull();
  const response = await createOAuthAdapter(f.options).token(
    new Request("https://auth.example/oauth/token", {
      method: "POST",
      body: new URLSearchParams({ grant_type: "authorization_code", code }),
    }),
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "invalid_grant" });
  expect(d.values.size).toBe(0);
}, 30_000);

test("grant hash, client, redirect and S256 verifier bindings are checked", async () => {
  const f = await fixture();
  expect(await validateCodeBindings(form(), f.options.storage)).toBe(true);
  for (const fields of [
    { code: "person:grant:wrong" },
    { client_id: "wrong" },
    { redirect_uri: "https://other.example/callback" },
    { code_verifier: "wrong" },
  ]) {
    expect(await validateCodeBindings(form(fields), f.options.storage)).toBe(
      false,
    );
  }
  for (const fields of [
    { authCodeId: "wrong" },
    { codeChallenge: "wrong" },
    { codeChallengeMethod: "plain" },
    { codeChallengeMethod: undefined },
    { redirectUri: undefined },
  ]) {
    await f.options.storage.put(
      "grant:person:grant",
      JSON.stringify({ ...f.grant, ...fields }),
    );
    expect(await validateCodeBindings(form(), f.options.storage)).toBe(false);
  }
  await f.options.storage.delete("grant:person:grant");
  expect(await validateCodeBindings(form(), f.options.storage)).toBe(false);
}, 30_000);

test("adapter burns a mismatched code, sanitizes errors and refuses a correct retry", async () => {
  const f = await fixture();
  const api = createOAuthAdapter(f.options);
  for (const [grant, proof] of [
    ["authorization_code", "wrong"],
    ["authorization_code", verifier],
    ["refresh_token", verifier],
    ["client_credentials", verifier],
    ["unknown", verifier],
  ] as const) {
    const body = new URLSearchParams({
      grant_type: grant,
      code,
      code_verifier: proof,
      refresh_token: "private-token",
      client_id: "public-client",
      redirect_uri: f.grant.redirectUri,
    });
    const response = await api.token(
      new Request("https://auth.example/oauth/token", { method: "POST", body }),
    );
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      error:
        grant === "authorization_code"
          ? "invalid_grant"
          : grant === "refresh_token"
            ? "invalid_client"
            : "unsupported_grant_type",
    });
    for (const secret of [code, verifier, "wrong", "private-token"])
      expect(text).not.toContain(secret);
  }
}, 30_000);
