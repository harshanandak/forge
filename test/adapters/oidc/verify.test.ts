import { expect, test } from "bun:test";
import {
  createOidcVerifier,
  type OidcConfig,
  type OidcHttpPort,
} from "../../../src/adapters/oidc/index.ts";
import {
  isVerifiedIdentity,
  type IdentityRefusal,
  type VerifiedIdentity,
} from "../../../src/ports/identity.ts";

const config: OidcConfig = {
  issuer: "https://issuer.example/",
  audience: "forge",
  algorithms: ["RS256"],
  jwksUrl: "https://issuer.example/keys",
  cacheTtlMs: 60_000,
  refreshIntervalMs: 1_000,
  fetchTimeoutMs: 25,
};
const claims = {
  iss: config.issuer,
  sub: " Person-A ",
  aud: "forge",
  exp: 200,
  auth_time: 50,
};
const rsa = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
};
const keys = Promise.all(
  ["first", "rotated"].map(async (kid) => {
    const pair = await crypto.subtle.generateKey(rsa, true, ["sign", "verify"]);
    return {
      pair,
      jwk: {
        ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
        kid,
        alg: "RS256",
        use: "sig",
      },
    };
  }),
);
const encode = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const refused = (reason: IdentityRefusal = "invalid_proof") => ({
  ok: false as const,
  reason,
});
async function token(
  payload: Record<string, unknown> = {},
  header = {},
  signer = 0,
): Promise<string> {
  const selected = (await keys)[signer]!;
  const input = `${encode({ alg: "RS256", kid: selected.jwk.kid, ...header })}.${encode({ ...claims, ...payload })}`;
  const signature = await crypto.subtle.sign(
    rsa,
    selected.pair.privateKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${Buffer.from(signature).toString("base64url")}`;
}
async function fixture(get?: OidcHttpPort["get"]) {
  const pairs = await keys;
  let now = 100_000,
    fetches = 0;
  let jwks: unknown = { keys: [pairs[0]!.jwk] };
  const urls: string[] = [];
  const verifier = createOidcVerifier(
    config,
    {
      get: (url, signal) => {
        fetches++;
        urls.push(url);
        return get ? get(url, signal) : Promise.resolve(JSON.stringify(jwks));
      },
    },
    { now: () => now },
  );
  return {
    verify: async (proof: unknown, audience = "forge") =>
      verifier.verify(proof, audience, now),
    advance: (ms: number) => {
      now += ms;
    },
    rotate: () => {
      jwks = { keys: [pairs[1]!.jwk] };
    },
    fetches: () => fetches,
    urls,
  };
}

test("signed proof yields exact identity and millisecond times", async () => {
  const f = await fixture();
  expect<unknown>(await f.verify(await token())).toEqual({
    ok: true,
    identity: {
      issuer: config.issuer,
      subject: claims.sub,
      audience: "forge",
      expiresAt: 200_000,
      authenticatedAt: 50_000,
    },
  });
  expect(f.urls).toEqual([config.jwksUrl]);
}, 5_000);

for (const [name, payload, header, reason] of [
  ["issuer", { iss: "https://issuer.example" }, {}, "invalid_proof"],
  ["audience", { aud: "other" }, {}, "wrong_audience"],
  ["empty subject", { sub: "" }, {}, "empty_subject"],
  ["exact expiry", { exp: 100 }, {}, "expired"],
  ["not-before", { nbf: 100.001 }, {}, "invalid_proof"],
  ["none", {}, { alg: "none" }, "invalid_proof"],
  ["unconfigured algorithm", {}, { alg: "HS256" }, "invalid_proof"],
  ["key URL", {}, { jku: "https://attacker.example" }, "invalid_proof"],
  ["certificate URL", {}, { x5u: "https://attacker.example" }, "invalid_proof"],
  ["embedded key", {}, { jwk: { kty: "RSA" } }, "invalid_proof"],
] as const) {
  test(`refuses ${name}`, async () => {
    const f = await fixture();
    expect(await f.verify(await token(payload, header))).toEqual(
      refused(reason),
    );
    expect(f.urls.every((url) => url === config.jwksUrl)).toBe(true);
  }, 5_000);
}

test("forged signatures, unsigned tokens and caller audience fail", async () => {
  const f = await fixture();
  expect(await f.verify(await token({}, { kid: "first" }, 1))).toEqual(
    refused(),
  );
  expect(
    await f.verify(`${encode({ alg: "none" })}.${encode(claims)}.`),
  ).toEqual(refused());
  expect(await f.verify(await token(), "other")).toEqual(
    refused("wrong_audience"),
  );
}, 5_000);

test("zero skew accepts just before expiry and exactly at not-before", async () => {
  const f = await fixture();
  expect(await f.verify(await token({ exp: 100.001, nbf: 100 }))).toMatchObject(
    { ok: true },
  );
}, 5_000);

test("rotation refreshes once, then reuses the new key", async () => {
  const f = await fixture();
  expect(await f.verify(await token())).toMatchObject({ ok: true });
  f.rotate();
  f.advance(1_000);
  for (let i = 0; i < 2; i++)
    expect(await f.verify(await token({}, {}, 1))).toMatchObject({ ok: true });
  expect(f.fetches()).toBe(2);
}, 5_000);

test("unknown keys get one refresh with no second fetch until the clock permits", async () => {
  const f = await fixture();
  await f.verify(await token());
  const unknown = await token({}, { kid: "missing" });
  expect(await f.verify(unknown)).toEqual(refused());
  expect(f.fetches()).toBe(1);
  f.advance(1_000);
  for (const kid of ["missing", "another"])
    expect(await f.verify(await token({}, { kid }))).toEqual(refused());
  expect(f.fetches()).toBe(2);
}, 5_000);

test("malformed proofs return only typed refusals", async () => {
  const f = await fixture();
  for (const proof of [null, {}, "", "bad.token.signature"])
    expect(await f.verify(proof)).toEqual(refused());
}, 5_000);

test("plain object cannot type-check as verified identity", () => {
  // @ts-expect-error Only an authenticating verifier can mint VerifiedIdentity.
  const forged: VerifiedIdentity = {
    issuer: config.issuer,
    subject: claims.sub,
    audience: "forge",
    expiresAt: 200_000,
    authenticatedAt: 50_000,
  };
  expect(forged.subject).toBe(claims.sub);
}, 5_000);

test("stalled HTTP ignores abort but the deadline clears pending for a later refresh", async () => {
  const body = JSON.stringify({ keys: [(await keys)[0]!.jwk] });
  const signals: AbortSignal[] = [];
  const f = await fixture((_url, signal) => {
    signals.push(signal);
    return signals.length === 1
      ? new Promise<string>(() => {})
      : Promise.resolve(body);
  });
  const proof = await token();
  const sentinel = Promise.withResolvers<string>();
  const timer = setTimeout(() => sentinel.resolve("deadline missed"), 500);
  const result = await Promise.race([f.verify(proof), sentinel.promise]);
  clearTimeout(timer);
  expect(result).toEqual(refused());
  expect(signals[0]?.aborted).toBe(true);
  expect(await f.verify(proof)).toEqual(refused());
  expect(f.fetches()).toBe(1);
  f.advance(config.refreshIntervalMs);
  expect(await f.verify(proof)).toMatchObject({ ok: true });
  expect(f.fetches()).toBe(2);
}, 5_000);

test("oversized text is refused before parsing, including its UTF-8 byte size", async () => {
  for (const padding of ["x".repeat(65_536), "é".repeat(34_000)]) {
    const body = JSON.stringify({ keys: [(await keys)[0]!.jwk], padding });
    const f = await fixture(() => Promise.resolve(body));
    expect(await f.verify(await token())).toEqual(refused());
  }
}, 5_000);

test("oversized key fields are refused", async () => {
  for (const field of [
    { kid: "k".repeat(129) },
    { n: "A".repeat(684) },
    { e: "A".repeat(9) },
  ]) {
    const jwk = { ...(await keys)[0]!.jwk, ...field };
    const f = await fixture(() =>
      Promise.resolve(JSON.stringify({ keys: [jwk] })),
    );
    expect(await f.verify(await token({}, { kid: jwk.kid }))).toEqual(
      refused(),
    );
  }
}, 5_000);

test("mixed JWKS skips unrelated and malformed public keys", async () => {
  const signing = (await keys)[0]!.jwk;
  const body = JSON.stringify({
    keys: [
      { ...signing, use: "enc" },
      { kty: "EC", kid: signing.kid },
      { ...signing, alg: "RS512" },
      { ...signing, key_ops: ["encrypt"] },
      { ...signing, n: "A".repeat(684) },
      { ...signing, n: "invalid!" },
      null,
      signing,
    ],
  });
  const f = await fixture(() => Promise.resolve(body));
  expect(await f.verify(await token())).toMatchObject({ ok: true });
}, 5_000);

test("only non-applicable keys never verify a token", async () => {
  const signing = (await keys)[0]!.jwk;
  const body = JSON.stringify({
    keys: [
      { ...signing, use: "enc" },
      { kty: "EC", kid: signing.kid },
      { ...signing, alg: "RS512" },
      { ...signing, key_ops: ["encrypt"] },
    ],
  });
  const f = await fixture(() => Promise.resolve(body));
  expect(await f.verify(await token())).toEqual(refused());
}, 5_000);

test("private fields refuse the whole set even on unrelated entries", async () => {
  const signing = (await keys)[0]!.jwk;
  for (const field of ["d", "p", "q", "dp", "dq", "qi"]) {
    const body = JSON.stringify({
      keys: [signing, { kty: "EC", [field]: "private" }],
    });
    const f = await fixture(() => Promise.resolve(body));
    expect(await f.verify(await token())).toEqual(refused());
  }
}, 5_000);

test("signed OIDC proof yields runtime-verified identity", async () => {
  const f = await fixture();
  const result = await f.verify(await token());
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected verified identity");
  expect(isVerifiedIdentity(result.identity)).toBe(true);
  expect(Object.isFrozen(result.identity)).toBe(true);
  expect(isVerifiedIdentity({ ...result.identity })).toBe(false);
}, 5_000);
