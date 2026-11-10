const rsa = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
};
const keys = crypto.subtle.generateKey(rsa, true, ["sign", "verify"]);
let otherKeys: typeof keys | undefined;
const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
export async function jwtFixture(
  issuer: string,
  audience: string,
  options: {
    claims?: Record<string, unknown>;
    algorithm?: string;
    wrongKey?: boolean;
  } = {},
) {
  const pair = await keys;
  const data = `${encode({ alg: options.algorithm ?? "RS256", kid: "recorded" })}.${encode({ iss: issuer, sub: "person", aud: audience, auth_time: 500, exp: 2000, ...options.claims })}`;
  const signing = options.wrongKey
    ? await (otherKeys ??= crypto.subtle.generateKey(rsa, true, [
        "sign",
        "verify",
      ]))
    : pair;
  const signature = await crypto.subtle.sign(
    rsa,
    signing.privateKey,
    new TextEncoder().encode(data),
  );
  return {
    proof: `${data}.${Buffer.from(signature).toString("base64url")}`,
    jwk: {
      ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
      kid: "recorded",
    },
  };
}
