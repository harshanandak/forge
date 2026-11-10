import { expect, test } from "bun:test";
import { createClerkBinding } from "../../../cloud/src/adapters/workers-oauth/clerk/index.ts";
import { createOidcVerifier } from "../../../src/adapters/oidc/index.ts";
import { isVerifiedIdentity } from "../../../src/ports/identity.ts";

const issuer = "https://clerk.example/",
  audience = "forge";
const recorded = {
  iss: issuer,
  sub: "person",
  aud: audience,
  auth_time: 500,
  exp: 2000,
  org_id: "org-a",
  email: "person@example.test",
  name: "Person",
};
const clock = { now: () => 1_000_000 };
const rsa = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
};
const keys = crypto.subtle.generateKey(rsa, true, ["sign", "verify"]);
const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
async function fixture(patch = {}, trustedIssuer = issuer, forged = false) {
  const pair = await keys;
  const input = `${encode({ alg: "RS256", kid: "recorded" })}.${encode({ ...recorded, ...patch })}`;
  const signed = new Uint8Array(
    await crypto.subtle.sign(
      rsa,
      pair.privateKey,
      new TextEncoder().encode(input),
    ),
  );
  if (forged) signed[0] = signed[0]! ^ 1;
  const proof = `${input}.${Buffer.from(signed).toString("base64url")}`;
  const jwk = {
    ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
    kid: "recorded",
  };
  const verifier = createOidcVerifier(
    {
      issuer: trustedIssuer,
      audience,
      algorithms: ["RS256"],
      jwksUrl: `${trustedIssuer}keys`,
      cacheTtlMs: 60_000,
      refreshIntervalMs: 1000,
      fetchTimeoutMs: 25,
    },
    { get: () => Promise.resolve(JSON.stringify({ keys: [jwk] })) },
    clock,
  );
  const binding = createClerkBinding(verifier, audience, clock);
  return { verify: () => binding.verify({ id_token: proof }), proof };
}

test("recorded issuers share the contract; profile changes never add authority or change the person key", async () => {
  const identities = [];
  for (const patch of [
    {},
    { org_id: "org-b" },
    { email: "other@example.test" },
    { name: "Other" },
    {
      org_id: "org-b",
      email: "other@example.test",
      name: "Other",
      project_access: ["admin"],
    },
    { sub: "second-person" },
    { iss: "https://second.example/" },
  ]) {
    const claims = { ...recorded, ...patch };
    const f = await fixture(patch, claims.iss);
    const result = await f.verify();
    expect<unknown>(result).toEqual({
      ok: true,
      identity: {
        issuer: claims.iss,
        subject: claims.sub,
        audience,
        authenticatedAt: 500_000,
        expiresAt: 2_000_000,
      },
    });
    if (!result.ok) throw new Error("Expected verified identity");
    expect(isVerifiedIdentity(result.identity)).toBe(true);
    identities.push(
      JSON.stringify([result.identity.issuer, result.identity.subject]),
    );
  }
  for (const key of identities.slice(1, 5)) expect(key).toBe(identities[0]!);
  expect(identities[0]).not.toBe(identities[5]);
  expect(identities[0]).not.toBe(identities[6]);
}, 5_000);

for (const [name, patch, forged, reason] of [
  ["issuer", { iss: "https://wrong.example/" }, false, "invalid_proof"],
  ["audience", { aud: "wrong" }, false, "wrong_audience"],
  ["expiry", { exp: 1000 }, false, "expired"],
  ["signature", {}, true, "invalid_proof"],
] as const) {
  test(`configured verifier refuses wrong ${name} without exposing proof`, async () => {
    const f = await fixture(patch, issuer, forged);
    const result = await f.verify();
    expect(result).toEqual({ ok: false, reason });
    expect(JSON.stringify(result)).not.toContain(f.proof);
  }, 5_000);
}
