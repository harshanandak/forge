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
  return sign(input, signer);
}
async function sign(input: string, signer = 0): Promise<string> {
  const selected = (await keys)[signer]!;
  const signature = await crypto.subtle.sign(
    rsa,
    selected.pair.privateKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${Buffer.from(signature).toString("base64url")}`;
}
async function fixture(get?: OidcHttpPort["get"], options = config) {
  const pairs = await keys;
  let now = 100_000,
    fetches = 0;
  let jwks: unknown = { keys: [pairs[0]!.jwk] };
  const urls: string[] = [];
  const verifier = createOidcVerifier(
    options,
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

test("refuses an HMAC signed with RSA public key bytes as its secret", async () => {
  const selected = (await keys)[0]!;
  const secret = await crypto.subtle.exportKey("spki", selected.pair.publicKey);
  const hmac = { name: "HMAC", hash: "SHA-256" };
  const key = await crypto.subtle.importKey("raw", secret, hmac, false, [
    "sign",
  ]);
  const input = `${encode({ alg: "HS256", kid: selected.jwk.kid })}.${encode(claims)}`;
  const signature = await crypto.subtle.sign(
    hmac,
    key,
    new TextEncoder().encode(input),
  );
  const f = await fixture(undefined, {
    ...config,
    algorithms: ["RS256", "HS256"],
  });
  expect(
    await f.verify(`${input}.${Buffer.from(signature).toString("base64url")}`),
  ).toEqual(refused());
  expect(f.fetches()).toBe(0);
}, 5_000);

test("refuses RS256 when configuration excludes it", async () => {
  const f = await fixture(undefined, { ...config, algorithms: ["RS512"] });
  expect(await f.verify(await token())).toEqual(refused());
  expect(f.fetches()).toBe(0);
}, 5_000);

for (const metadata of [
  { use: "enc" },
  { alg: "RS512" },
  { kty: "EC" },
  { key_ops: ["encrypt"] },
]) {
  test(`refuses mismatched JWK metadata ${JSON.stringify(metadata)}`, async () => {
    const jwk = { ...(await keys)[0]!.jwk, ...metadata };
    const f = await fixture(() =>
      Promise.resolve(JSON.stringify({ keys: [jwk] })),
    );
    expect(await f.verify(await token())).toEqual(refused());
    expect(f.fetches()).toBe(1);
  }, 5_000);
}

for (const [field, value, reason] of [
  ["iss", undefined, "invalid_proof"],
  ["iss", null, "invalid_proof"],
  ["iss", 42, "invalid_proof"],
  ["iss", "", "empty_issuer"],
  ["sub", undefined, "invalid_proof"],
  ["sub", null, "invalid_proof"],
  ["sub", 42, "invalid_proof"],
  ["aud", undefined, "wrong_audience"],
  ["aud", null, "wrong_audience"],
  ["aud", 42, "wrong_audience"],
  ["aud", "", "wrong_audience"],
  ["exp", undefined, "invalid_proof"],
  ["exp", null, "invalid_proof"],
  ["exp", "200", "invalid_proof"],
  ["iat", null, "invalid_proof"],
  ["iat", "50", "invalid_proof"],
  ["iat", false, "invalid_proof"],
  ["iat", -0.001, "invalid_proof"],
  ["iat", 100.001, "invalid_proof"],
] as const) {
  test(`refuses ${field}=${String(value)}`, async () => {
    const f = await fixture();
    expect(await f.verify(await token({ [field]: value }))).toEqual(
      refused(reason),
    );
  }, 5_000);
}

test("refuses non-finite timestamps encoded as JSON numbers", async () => {
  const header = encode({ alg: "RS256", kid: "first" });
  for (const field of ["exp", "iat"]) {
    // Serialize numeric overflow without JSON.stringify turning it into null.
    const raw = JSON.stringify({ ...claims, [field]: "1e400" }).replace(
      '"1e400"',
      "1e400",
    );
    const f = await fixture();
    expect(
      await f.verify(
        await sign(`${header}.${Buffer.from(raw).toString("base64url")}`),
      ),
    ).toEqual(refused());
  }
}, 5_000);

test("refuses issuance after expiry even when issuance is not in the future", async () => {
  const f = await fixture();
  expect(await f.verify(await token({ iat: 99.5, exp: 99 }))).toEqual(
    refused(),
  );
}, 5_000);

test("optional issuance accepts absence, zero, past fractions and exactly now", async () => {
  const f = await fixture();
  for (const iat of [undefined, 0, 99.999, 100])
    expect(await f.verify(await token({ iat }))).toMatchObject({ ok: true });
  expect(await f.verify(await token({ iat: 100, exp: 100 }))).toEqual(
    refused("expired"),
  );
}, 5_000);

test("audience arrays require the configured audience and authorized party", async () => {
  const f = await fixture();
  for (const aud of [["forge"], ["other", "forge"], ["forge", "other"]])
    expect(await f.verify(await token({ aud, azp: "forge" }))).toMatchObject({
      ok: true,
    });
  for (const aud of [[], ["other"], ["other", "another"], ["forge", 42]])
    expect(await f.verify(await token({ aud, azp: "forge" }))).toEqual(
      refused("wrong_audience"),
    );
  for (const azp of [undefined, "other"])
    expect(
      await f.verify(await token({ aud: ["forge", "other"], azp })),
    ).toEqual(refused());
}, 5_000);

for (const [location, member] of [
  ["header", '"alg":"none","alg":"RS256"'],
  ["header", '"alg":"none","\\u0061lg":"RS256"'],
  ["payload", '"sub":"attacker","sub":" Person-A "'],
  ["payload", '"sub":"attacker","\\u0073ub":" Person-A "'],
  ["payload", '"sub":" Person-A ","nested":{"x":1,"\\u0078":2}'],
  ["payload", '"sub":" Person-A ","nested":[{"x":1,"x":2}]'],
] as const) {
  test(`refuses duplicate JSON members in ${location}: ${member}`, async () => {
    const header =
      location === "header"
        ? `{${member},"kid":"first"}`
        : '{"alg":"RS256","kid":"first"}';
    const payload =
      location === "payload"
        ? JSON.stringify(claims).replace('"sub":" Person-A "', member)
        : JSON.stringify(claims);
    const input = [header, payload]
      .map((raw) => Buffer.from(raw).toString("base64url"))
      .join(".");
    const f = await fixture();
    expect(await f.verify(await sign(input))).toEqual(refused());
  }, 5_000);
}

test("duplicate scanning preserves strings and independent object scopes", async () => {
  const f = await fixture();
  const proof = await token({
    note: '{"sub":"quoted","sub":"text"} [ ] \\ " :',
    nested: { sub: "nested", child: { sub: "child" } },
    items: [{ sub: "first" }, { sub: "second" }],
  });
  expect(await f.verify(proof)).toMatchObject({ ok: true });
}, 5_000);

test("refuses malformed base64url in each segment and wrong signature lengths", async () => {
  const proof = await token();
  const parts = proof.split(".");
  const f = await fixture();
  for (let index = 0; index < parts.length; index++) {
    for (const replacement of [
      "",
      `${parts[index]}=`,
      `${parts[index]}!`,
      "A",
    ]) {
      const malformed =
        index === 1
          ? await sign(`${parts[0]}.${replacement}`)
          : parts
              .map((part, i) => (i === index ? replacement : part))
              .join(".");
      expect(await f.verify(malformed)).toEqual(refused());
    }
  }
  const signature = Buffer.from(parts[2]!, "base64url");
  for (const bytes of [
    signature.subarray(0, -1),
    Buffer.concat([signature, Buffer.from([0])]),
  ])
    expect(
      await f.verify(`${parts[0]}.${parts[1]}.${bytes.toString("base64url")}`),
    ).toEqual(refused());
}, 5_000);

test("concurrent cold and expired JWKS refreshes share exactly one fetch", async () => {
  const body = JSON.stringify({ keys: [(await keys)[0]!.jwk] });
  const proof = await token();
  for (const stale of [false, true]) {
    let response = Promise.resolve(body);
    const f = await fixture(() => response);
    if (stale) {
      expect(await f.verify(proof)).toMatchObject({ ok: true });
      f.advance(config.cacheTtlMs);
    }
    const gate = Promise.withResolvers<string>();
    response = gate.promise;
    const before = f.fetches();
    const pending = Array.from({ length: 8 }, () => f.verify(proof));
    expect(f.fetches() - before).toBe(1);
    gate.resolve(body);
    const results = await Promise.all(pending);
    for (const result of results) expect(result).toMatchObject({ ok: true });
    expect(f.fetches() - before).toBe(1);
  }
}, 5_000);

test("failed JWKS fetch recovers when the refresh interval permits", async () => {
  const body = JSON.stringify({ keys: [(await keys)[0]!.jwk] });
  let calls = 0;
  const f = await fixture(() =>
    ++calls === 1
      ? Promise.reject(new Error("Unavailable"))
      : Promise.resolve(body),
  );
  const proof = await token();
  expect(await f.verify(proof)).toEqual(refused());
  expect(await f.verify(proof)).toEqual(refused());
  expect(f.fetches()).toBe(1);
  f.advance(config.refreshIntervalMs);
  expect(await f.verify(proof)).toMatchObject({ ok: true });
  expect(f.fetches()).toBe(2);
}, 5_000);
