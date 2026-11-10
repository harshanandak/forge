import { expect, test } from "bun:test";
import {
  CodeRedemption,
  durableRedemption,
  validateCodeBindings,
  type ClaimStore,
} from "../../../cloud/src/adapters/workers-oauth/redemption.ts";
import { createOAuthAdapter } from "../../../cloud/src/adapters/workers-oauth/index.ts";
import { createOAuthHarness } from "../../adapters/workers-oauth/harness.ts";

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
  );
  return { ...harness, grant, hash };
}
function durableFixture() {
  const values = new Map<string, number>(),
    names: string[] = [],
    payloads: string[] = [],
    responses: string[] = [];
  let tail = Promise.resolve();
  const store: ClaimStore = {
    get: <T>(key: string) => Promise.resolve(values.get(key) as T | undefined),
    put: (key, value) => {
      values.set(key, value);
      return Promise.resolve();
    },
  };
  const object = new CodeRedemption({
    storage: {
      ...store,
      transaction<T>(operation: (store: ClaimStore) => Promise<T>) {
        const result = tail.then(() => operation(store));
        tail = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      },
    },
  });
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
  return { object, port, values, names, payloads, responses };
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
  expect(f.responses.map((body) => JSON.parse(body) as unknown)).toContainEqual(
    {
      error: "invalid_grant",
    },
  );
  const stored = JSON.stringify([...f.values]),
    sent = f.payloads.join(" ");
  for (const secret of [code, verifier, "private-token"]) {
    expect(stored).not.toContain(secret);
    expect(sent).not.toContain(secret);
    expect(f.responses.join(" ")).not.toContain(secret);
  }
}, 30_000);

test("grant hash, client, redirect and S256 verifier bind before a claim", async () => {
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

test("adapter rejects a binding mismatch before claiming and sanitizes its error", async () => {
  const f = await fixture();
  let claims = 0;
  f.options.codeRedemption = {
    claimOnce: () => {
      claims++;
      return Promise.resolve(true);
    },
  };
  const api = createOAuthAdapter(f.options);
  for (const grant of [
    "authorization_code",
    "refresh_token",
    "client_credentials",
    "unknown",
  ]) {
    const body = new URLSearchParams({
      grant_type: grant,
      code,
      code_verifier: "wrong",
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
          : "unsupported_grant_type",
    });
    for (const secret of [code, verifier, "wrong", "private-token"])
      expect(text).not.toContain(secret);
  }
  expect(claims).toBe(0);
}, 30_000);
