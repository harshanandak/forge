import { subtle } from "node:crypto";
import type { ClockPort } from "../../ports/clock.ts";
import { mintIdentity } from "../../ports/identity-mint.ts";
import { IdentityVerifier, type IdentityResult } from "../../ports/identity.ts";

export interface OidcConfig {
  readonly issuer: string;
  readonly audience: string;
  /** RS256 is supported; every other algorithm is refused even if configured. */
  readonly algorithms: readonly string[];
  readonly jwksUrl: string;
  readonly cacheTtlMs: number;
  readonly refreshIntervalMs: number;
  readonly fetchTimeoutMs: number;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected an object");
  return value as Record<string, unknown>;
}

function bytes(part: string): Buffer<ArrayBuffer> {
  const decoded = Buffer.from(part, "base64url");
  if (!/^[A-Za-z0-9_-]+$/.test(part) || decoded.toString("base64url") !== part)
    throw new Error("Invalid encoding");
  return decoded;
}
function claims(part: string): Record<string, unknown> {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes(part));
  const parsed = object(JSON.parse(text));
  const scopes: (Set<string> | undefined)[] = [];
  // JSON.parse validates syntax but loses duplicate names; scan whole strings
  // so quoted punctuation cannot alter scope, and decode escaped member names.
  for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\]]/g)) {
    const token = match[0];
    if (token === "{") scopes.push(new Set<string>());
    else if (token === "[") scopes.push(undefined);
    else if (token === "}" || token === "]") scopes.pop();
    else if (/^\s*:/.test(text.slice(match.index + token.length))) {
      const names = scopes.at(-1);
      const name = JSON.parse(token) as string;
      if (!names || names.has(name)) throw new Error("Duplicate member name");
      names.add(name);
    }
  }
  return parsed;
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value * 1_000);
}

function publicKey(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const key = object(value);
  if (["d", "p", "q", "dp", "dq", "qi"].some((field) => field in key))
    throw new Error("Private key material in key set");
  try {
    if (
      key.kty !== "RSA" ||
      typeof key.kid !== "string" ||
      !key.kid ||
      key.kid.length > 128 ||
      typeof key.n !== "string" ||
      key.n.length > 683 ||
      bytes(key.n).length > 512 ||
      typeof key.e !== "string" ||
      key.e.length > 8 ||
      !bytes(key.e).length ||
      (key.alg !== undefined && key.alg !== "RS256") ||
      (key.use !== undefined && key.use !== "sig") ||
      (key.key_ops !== undefined &&
        (!Array.isArray(key.key_ops) ||
          !key.key_ops.every((op) => typeof op === "string") ||
          !key.key_ops.includes("verify")))
    )
      return undefined;
    return { kid: key.kid, n: key.n, e: key.e };
  } catch {
    return undefined;
  }
}

export interface OidcHttpPort {
  get(url: string, signal: AbortSignal): Promise<string>;
}

export function createOidcVerifier(
  input: OidcConfig,
  http: OidcHttpPort,
  clock: ClockPort,
): IdentityVerifier {
  const config = { ...input, algorithms: [...input.algorithms] };
  let keys: NonNullable<ReturnType<typeof publicKey>>[] = [];
  let expiresAt = -Infinity,
    refreshedAt = -Infinity;
  let pending: Promise<void> | undefined;
  const invalid: IdentityResult = { ok: false, reason: "invalid_proof" };
  async function refresh(at: number): Promise<void> {
    if (pending) return pending;
    if (at - refreshedAt < config.refreshIntervalMs) return;
    // Reserve before awaiting HTTP so concurrent and failed requests share the limit.
    refreshedAt = at;
    pending = (async () => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const deadline = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error("Key fetch deadline"));
            controller.abort();
          }, config.fetchTimeoutMs);
        });
        // Race independently of abort: a broken port may ignore the signal.
        const body = await Promise.race([
          http.get(config.jwksUrl, controller.signal),
          deadline,
        ]);
        if (
          typeof body !== "string" ||
          body.length > 65_536 ||
          Buffer.byteLength(body, "utf8") > 65_536
        )
          throw new Error("Key set too large");
        const jwks = object(JSON.parse(body));
        if (!Array.isArray(jwks.keys) || jwks.keys.length > 100)
          throw new Error("Invalid key set");
        const next = jwks.keys
          .map(publicKey)
          .filter((key) => key !== undefined);
        const freshUntil = clock.now() + config.cacheTtlMs;
        if (!Number.isFinite(freshUntil)) throw new Error("Invalid clock");
        keys = next;
        expiresAt = freshUntil;
      } finally {
        clearTimeout(timer);
      }
    })();
    try {
      await pending;
    } finally {
      pending = undefined;
    }
  }
  return new (class extends IdentityVerifier {
    async verify(
      proof: unknown,
      expectedAudience: string,
      now: number,
    ): Promise<IdentityResult> {
      try {
        if (
          typeof proof !== "string" ||
          proof.length > 16_384 ||
          !Number.isFinite(now) ||
          !config.issuer ||
          !config.audience ||
          !Number.isFinite(config.cacheTtlMs) ||
          config.cacheTtlMs <= 0 ||
          !Number.isFinite(config.refreshIntervalMs) ||
          config.refreshIntervalMs <= 0 ||
          !Number.isSafeInteger(config.fetchTimeoutMs) ||
          config.fetchTimeoutMs <= 0 ||
          config.fetchTimeoutMs > 2_147_483_647
        )
          return invalid;
        const parts = proof.split(".");
        if (parts.length !== 3) return invalid;
        const [head, body, sig] = parts as [string, string, string];
        const header = claims(head);
        if (
          header.alg !== "RS256" ||
          !config.algorithms.includes(header.alg) ||
          typeof header.kid !== "string" ||
          !header.kid ||
          header.kid.length > 128 ||
          ["jku", "x5u", "jwk", "crit", "b64"].some((field) => field in header)
        )
          return invalid;
        const signatureBytes = bytes(sig);
        const at = clock.now();
        if (!Number.isFinite(at) || at < refreshedAt) return invalid;
        // One refresh site per verification, whether the cache is stale or the kid is new.
        if (at >= expiresAt || !keys.some((key) => key.kid === header.kid))
          await refresh(at);
        if (clock.now() >= expiresAt) return invalid;
        const matching = keys.filter((key) => key.kid === header.kid);
        if (matching.length !== 1) return invalid;
        const jwk = matching[0]!;
        const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
        const key = await subtle.importKey(
          "jwk",
          { kty: "RSA", n: jwk.n, e: jwk.e },
          algorithm,
          false,
          ["verify"],
        );
        if (
          !("modulusLength" in key.algorithm) ||
          typeof key.algorithm.modulusLength !== "number" ||
          key.algorithm.modulusLength < 2048 ||
          !(await subtle.verify(
            algorithm,
            key,
            signatureBytes,
            new TextEncoder().encode(`${head}.${body}`),
          ))
        )
          return invalid;
        const payload = claims(body);
        if (payload.iss === "") return { ok: false, reason: "empty_issuer" };
        if (payload.iss !== config.issuer) return invalid;
        if (payload.sub === "") return { ok: false, reason: "empty_subject" };
        if (typeof payload.sub !== "string") return invalid;
        const audiences = Array.isArray(payload.aud)
          ? payload.aud
          : [payload.aud];
        if (
          expectedAudience !== config.audience ||
          !audiences.every((aud) => typeof aud === "string") ||
          !audiences.includes(config.audience)
        )
          return { ok: false, reason: "wrong_audience" };
        if (
          (audiences.length > 1 || payload.azp !== undefined) &&
          payload.azp !== config.audience
        )
          return invalid;
        const decisionTime = Math.max(now, clock.now());
        if (
          !Number.isFinite(decisionTime) ||
          decisionTime >= expiresAt ||
          !timestamp(payload.exp) ||
          (payload.iat !== undefined &&
            (!timestamp(payload.iat) ||
              payload.iat < 0 ||
              payload.iat * 1_000 > decisionTime ||
              payload.iat > payload.exp)) ||
          !timestamp(payload.auth_time) ||
          payload.auth_time * 1_000 > decisionTime ||
          (payload.nbf !== undefined &&
            (!timestamp(payload.nbf) || decisionTime < payload.nbf * 1_000))
        )
          return invalid;
        // No clock skew: equality at expiry is expired; equality at nbf is valid.
        if (decisionTime >= payload.exp * 1_000)
          return { ok: false, reason: "expired" };
        return {
          ok: true,
          identity: mintIdentity({
            issuer: config.issuer,
            subject: payload.sub,
            audience: config.audience,
            expiresAt: payload.exp * 1_000,
            authenticatedAt: payload.auth_time * 1_000,
          }),
        };
      } catch {
        // Parsing, HTTP and crypto failures expose no credential material.
        return invalid;
      }
    }
  })();
}
