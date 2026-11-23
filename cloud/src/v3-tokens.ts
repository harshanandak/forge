import { ForgeFailure } from "../../src/contract/failure.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import { TABLE_PROBE } from "./store.ts";
import {
  type DeviceInput,
  holderOf,
  MAX_TTL_MS,
  mint,
  same,
  sha256,
} from "./tokens.ts";
import { fail, readV3Root, V3_TOKENS } from "./v3-store.ts";
import {
  type Seal,
  signToken,
  type TokenFields,
  verifyToken,
} from "./v3-seal.ts";

const TEXT_BYTES = 8192;
const DEVICE_CHARS = 256;
const LABEL_CHARS = 200;
const LAST_TIME = 8_640_000_000_000_000;
const NO_ROW_HASH = "0".repeat(64);
const ID = /^[0-9a-f]{16}$/;
const HASH = /^[0-9a-f]{64}$/;

const exact = (column: string, bytes: number) =>
  `typeof(${column})='text' AND length(CAST(${column} AS BLOB))=${bytes}`;
const label = (column: string, optional: boolean) =>
  `${optional ? `${column} IS NULL OR ` : ""}(typeof(${column})='text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND ${TEXT_BYTES})`;
const time = (column: string, optional: boolean) =>
  `${optional ? `${column} IS NULL OR ` : ""}(typeof(${column})='integer' AND ${column} BETWEEN 0 AND ${LAST_TIME})`;

const SHAPES: Record<string, string> = {
  id: exact("id", 16),
  hash: exact("hash", 64),
  device: label("device", false),
  session: label("session", false),
  agent: label("agent", true),
  harness: label("harness", true),
  expires_at: time("expires_at", false),
  revoked_at: time("revoked_at", true),
  mac: exact("mac", 81),
};
const COLUMNS = Object.keys(SHAPES);

export const TOKEN_READ = `WITH guarded AS (SELECT ${COLUMNS.map((c) => `(${SHAPES[c]}) AS ${c}_ok`).join(", ")}, ${COLUMNS.join(", ")} FROM ${V3_TOKENS} WHERE id=?) SELECT (${COLUMNS.map((c) => `${c}_ok`).join(" AND ")}) AS shape_ok, ${COLUMNS.map((c) => `CASE WHEN ${c}_ok THEN ${c} END AS ${c}`).join(", ")} FROM guarded`;

const CREATE = `CREATE TABLE IF NOT EXISTS ${V3_TOKENS} (id TEXT PRIMARY KEY, hash TEXT NOT NULL, device TEXT NOT NULL, session TEXT NOT NULL, agent TEXT, harness TEXT, expires_at INTEGER NOT NULL, revoked_at INTEGER, mac TEXT NOT NULL) WITHOUT ROWID`;

const unavailable = () =>
  fail("UNAVAILABLE", "Cloud v3 token storage is unavailable");
const invalid = () => fail("AUTH_INVALID", "Token is not valid");
const whole = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);
const holder = (t: TokenFields) =>
  holderOf({
    device: t.device,
    session: t.session,
    agent: t.agent,
    harness: t.harness,
    expires_at: t.expiresAt,
  });

function stored(db: SqlDatabase, id: string) {
  if (db.get(TABLE_PROBE, [V3_TOKENS]) === undefined) return undefined;
  const row = db.get(TOKEN_READ, [id]);
  if (row === undefined) return undefined;
  const { hash, device, session, agent, harness, mac } = row;
  const expiresAt = row.expires_at;
  const revokedAt = row.revoked_at;
  if (
    row.shape_ok !== 1 ||
    row.id !== id ||
    !ID.test(id) ||
    typeof hash !== "string" ||
    !HASH.test(hash) ||
    typeof device !== "string" ||
    typeof session !== "string" ||
    (agent !== null && typeof agent !== "string") ||
    (harness !== null && typeof harness !== "string") ||
    typeof mac !== "string" ||
    !whole(expiresAt) ||
    (revokedAt !== null && !whole(revokedAt))
  )
    throw unavailable();
  const fields: TokenFields = {
    id,
    hash,
    device,
    session,
    agent,
    harness,
    expiresAt,
    revokedAt,
  };
  return { fields, mac };
}

function authentic(db: SqlDatabase, seal: Seal, id: string) {
  const found = stored(db, id);
  if (found && !verifyToken(seal, found.fields, found.mac)) throw unavailable();
  return found?.fields;
}

const audit = (line: object) => console.log(JSON.stringify(line));

export function authorizeV3Token(
  db: SqlDatabase,
  seal: Seal,
  parts: { id: string; hash: string },
  now: number,
) {
  let token: TokenFields | undefined;
  try {
    token = authentic(db, seal, parts.id);
  } catch (error) {
    if (error instanceof ForgeFailure && error.error.code === "UNAVAILABLE")
      audit({
        auth: "refused",
        code: "UNAVAILABLE",
        ...(ID.test(parts.id) ? { id: parts.id } : {}),
      });
    throw error;
  }
  const match = same(parts.hash, token?.hash ?? NO_ROW_HASH);
  if (token === undefined || !match) {
    audit({ auth: "refused", code: "AUTH_INVALID" });
    throw invalid();
  }
  const refuse = (code: string, message: string) => {
    audit({ auth: "refused", code, ...holder(token) });
    return fail(code, message);
  };
  if (token.revokedAt !== null)
    throw refuse("AUTH_REVOKED", "Token was revoked");
  if (token.expiresAt <= now) throw refuse("AUTH_EXPIRED", "Token expired");
  audit({ auth: "granted", ...holder(token) });
  const { id, device, session, agent, harness, expiresAt } = token;
  return { id, device, session, agent, harness, expiresAt };
}

export async function issueV3Token(
  db: SqlDatabase,
  seal: Seal,
  input: DeviceInput,
  now: number,
): Promise<Record<string, unknown>> {
  if (input.ttlMs > MAX_TTL_MS)
    throw fail("INPUT_INVALID", "ttlMs is over 90 days");
  const { device, session, agent, harness } = input;
  if (session === null) throw fail("INPUT_INVALID", "session is required");
  for (const [value, max] of [
    [device, DEVICE_CHARS],
    [session, LABEL_CHARS],
    [agent, LABEL_CHARS],
    [harness, LABEL_CHARS],
  ] as const)
    if (
      value !== null &&
      (value === "" || /\p{Surrogate}/u.test(value) || [...value].length > max)
    )
      throw fail("INPUT_INVALID", "device labels must be well-formed text");
  const { id, secret } = mint();
  const fields: TokenFields = {
    id,
    hash: await sha256(secret),
    device,
    session,
    agent,
    harness,
    expiresAt: now + input.ttlMs,
    revokedAt: null,
  };
  db.transaction(() => {
    readV3Root(db, seal);
    db.exec(CREATE);
    db.run(
      `INSERT INTO ${V3_TOKENS} (id, hash, device, session, agent, harness, expires_at, revoked_at, mac) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      [
        id,
        fields.hash,
        device,
        session,
        agent,
        harness,
        fields.expiresAt,
        signToken(seal, fields),
      ],
    );
  });
  return { id, token: `fct_${id}.${secret}`, ...holder(fields) };
}

export function revokeV3Token(
  db: SqlDatabase,
  seal: Seal,
  id: string,
  now: number,
) {
  return db.transaction(() => {
    readV3Root(db, seal);
    let token = authentic(db, seal, id);
    if (token === undefined)
      throw fail("INPUT_INVALID", "No such device token");
    if (token.revokedAt === null) {
      token = { ...token, revokedAt: now };
      const { changes } = db.run(
        `UPDATE ${V3_TOKENS} SET revoked_at=?, mac=? WHERE id=? AND revoked_at IS NULL`,
        [now, signToken(seal, token), id],
      );
      if (changes !== 1) throw unavailable();
    }
    return { ...holder(token), leasesReleased: false };
  });
}
