import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { ForgeFailure } from "../../src/contract/failure.ts";
import { canonicalJson } from "../../src/core/config/pointer.ts";

export interface Key {
  readonly id: string;
  readonly bytes: Buffer;
}
export interface Seal {
  readonly scope: string;
  readonly keys: readonly [Key, ...Key[]];
}

export const BOUNDED_MAC =
  "CASE WHEN length(CAST(mac AS BLOB))=81 THEN mac END AS mac";

const SECRET = /^[A-Za-z0-9_-]{43,512}$/;
const ENVELOPE = /^([0-9a-f]{16})\.([0-9a-f]{64})$/;

function keyOf(secret: unknown): Key | undefined {
  if (
    typeof secret !== "string" ||
    !SECRET.test(secret) ||
    secret.length % 4 === 1
  )
    return undefined;
  const bytes = Buffer.from(secret, "base64url");
  return bytes.length < 32
    ? undefined
    : {
        id: createHash("sha256").update(bytes).digest("hex").slice(0, 16),
        bytes,
      };
}

export function ringOf(first: Key, second?: Key): Seal["keys"] | undefined {
  if (!second || second.bytes.equals(first.bytes)) return [first];
  return second.id === first.id ? undefined : [first, second];
}

export function sealKeys(
  current: unknown,
  previous?: unknown,
): Seal["keys"] | undefined {
  const first = keyOf(current);
  const second = previous === undefined ? undefined : keyOf(previous);
  return first && (previous === undefined || second)
    ? ringOf(first, second)
    : undefined;
}

export function sealOf(
  env: Readonly<Record<string, unknown>>,
  id: { toString(): string } | undefined,
): Seal {
  const keys = sealKeys(env.V3_SEAL_KEY, env.V3_SEAL_KEY_PREVIOUS);
  const scope = id?.toString();
  if (!keys || !scope)
    throw new ForgeFailure({
      code: "UNAVAILABLE",
      message: "Cloud v3 seal is not configured",
      retry: "never",
    });
  return { scope, keys };
}

const tag = (
  { bytes }: Key,
  scope: string,
  incarnation: unknown,
  sequence: number,
  body: string,
) =>
  createHmac("sha256", bytes)
    .update(
      canonicalJson(["forge/v3/commit/1", scope, incarnation, sequence, body]),
    )
    .digest();

export const signRow = (
  { scope, keys: [key] }: Seal,
  incarnation: unknown,
  sequence: number,
  body: string,
) =>
  `${key.id}.${tag(key, scope, incarnation, sequence, body).toString("hex")}`;

export function verifyRow(
  seal: Seal,
  incarnation: unknown,
  sequence: unknown,
  body: unknown,
  mac: unknown,
): boolean {
  const parts = typeof mac === "string" ? ENVELOPE.exec(mac) : null;
  const key = parts && seal.keys.find(({ id }) => id === parts[1]);
  if (!key || typeof body !== "string" || typeof sequence !== "number")
    return false;
  const expected = tag(key, seal.scope, incarnation, sequence, body);
  const given = Buffer.from(parts[2]!, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
