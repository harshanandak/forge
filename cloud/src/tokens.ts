// One bearer token per device. A token looks like fct_<id>.<secret>: the id is public and picks the
// row, the secret is shown once and only its SHA-256 is stored. The hashes are compared in constant
// time. Admin calls (issue, revoke) use a separate admin token held as a Worker secret.
import { ForgeFailure } from "../../src/contract/failure.ts";
import type { SqlDatabase, SqlRow } from "../../src/ports/store.ts";

export const TOKENS = "domain_cloud_tokens";
export const TOKEN_MIGRATION = {
  id: "002_cloud_tokens",
  statements: [
    `CREATE TABLE IF NOT EXISTS ${TOKENS} (id TEXT PRIMARY KEY, hash TEXT NOT NULL, device TEXT NOT NULL, session TEXT, agent TEXT, harness TEXT, expires_at INTEGER NOT NULL, revoked_at INTEGER)`,
  ],
};

/** The one token-by-id lookup. The read-only command view may run only this statement. */
export const TOKEN_LOOKUP = `SELECT * FROM ${TOKENS} WHERE id=?`;

const TOKEN = /^fct_([0-9a-f]{16})\.([A-Za-z0-9_-]{43})$/;
const NO_ROW_HASH = "0".repeat(64);
const MAX_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const denied = (code: string, message: string): ForgeFailure =>
  new ForgeFailure({ code, message, retry: "never" });
const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const random = (length: number): Uint8Array =>
  crypto.getRandomValues(new Uint8Array(length));

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return hex(new Uint8Array(digest));
}

interface Subtle {
  timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean;
}

/** Constant-time compare of two digests. Different lengths are simply not equal: the native call would throw. */
export function same(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  if (a.byteLength !== b.byteLength) return false;
  return (crypto.subtle as unknown as Subtle).timingSafeEqual(a, b);
}

/** True when the text has the shape of a device token; the Worker refuses anything else unseen. */
export const wellFormed = (presented: string): boolean => TOKEN.test(presented);

/** True when the text carries a device token, whole or inside other text: its `fct_` marker, in any case. */
export const carriesToken = (text: string): boolean => /fct_/i.test(text);

export function bearer(request: Request): string | undefined {
  return /^Bearer (\S+)$/i.exec(
    request.headers.get("authorization") ?? "",
  )?.[1];
}

const revoked = (row: SqlRow): boolean => row.revoked_at !== null;

/** The holder a token names: shown in every refusal and in the audit line of every grant. */
export function holderOf(row: SqlRow): Record<string, string> {
  const named: Record<string, string> = { device: String(row.device) };
  for (const key of ["session", "agent", "harness"])
    if (typeof row[key] === "string") named[key] = row[key];
  named.expiresAt = new Date(Number(row.expires_at)).toISOString();
  return named;
}
const naming = (row: SqlRow): string =>
  Object.entries(holderOf(row))
    .map(([key, value]) => `${key} ${value}`)
    .join(", ");

export interface DeviceInput {
  device: string;
  session: string | null;
  agent: string | null;
  harness: string | null;
  ttlMs: number;
}

export async function issueToken(
  db: SqlDatabase,
  input: DeviceInput,
  now: number,
): Promise<Record<string, unknown>> {
  if (input.ttlMs > MAX_TTL_MS)
    throw denied("INPUT_INVALID", "ttlMs is over 90 days");
  const id = hex(random(8));
  const secret = btoa(String.fromCharCode(...random(32)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  const expiresAt = now + input.ttlMs;
  const row: SqlRow = { ...input, expires_at: expiresAt };
  db.run(
    `INSERT INTO ${TOKENS} (id, hash, device, session, agent, harness, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      await sha256(secret),
      input.device,
      input.session,
      input.agent,
      input.harness,
      expiresAt,
    ],
  );
  return { id, token: `fct_${id}.${secret}`, ...holderOf(row) };
}

export function revokeToken(db: SqlDatabase, id: string, now: number) {
  const row = db.get(TOKEN_LOOKUP, [id]);
  if (row === undefined) throw denied("INPUT_INVALID", "No such device token");
  db.run(
    `UPDATE ${TOKENS} SET revoked_at=? WHERE id=? AND revoked_at IS NULL`,
    [now, id],
  );
  return holderOf(row);
}

/** First half of a device check: split the token and hash its secret. Reads no state. */
export async function tokenParts(presented: string) {
  const match = TOKEN.exec(presented);
  if (match === null) throw denied("AUTH_INVALID", "Token is not valid");
  return { id: match[1]!, hash: await sha256(match[2]!) };
}

// Every refusal and grant leaves one audit line that names the holder.
function refuse(code: string, what: string, row: SqlRow): ForgeFailure {
  console.log(JSON.stringify({ auth: "refused", code, ...holderOf(row) }));
  return denied(code, `Token ${what}: ${naming(row)}`);
}

/**
 * Second half, with no await after it: look the token up, then refuse a wrong, revoked or expired
 * one. Callers run their write right after, so a revoke can never fall between the check and the write.
 */
export function authorizeToken(
  db: SqlDatabase,
  parts: { id: string; hash: string },
  now: number,
): { device: string; session: string | null } {
  const row = db.get(TOKEN_LOOKUP, [parts.id]);
  const match = same(
    parts.hash,
    row === undefined ? NO_ROW_HASH : String(row.hash),
  );
  if (row === undefined || !match)
    throw denied("AUTH_INVALID", "Token is not valid");
  if (revoked(row)) throw refuse("AUTH_REVOKED", "was revoked", row);
  if (Number(row.expires_at) <= now)
    throw refuse("AUTH_EXPIRED", "expired", row);
  console.log(JSON.stringify({ auth: "granted", ...holderOf(row) }));
  return {
    device: String(row.device),
    session: typeof row.session === "string" ? row.session : null,
  };
}

/** The device a valid token names. */
export const authorize = (
  db: SqlDatabase,
  parts: { id: string; hash: string },
  now: number,
): string => authorizeToken(db, parts, now).device;
