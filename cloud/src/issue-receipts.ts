// Typed command receipts are server data; legacy evented records stay frozen in forge/cloud.
// A receipt holds the input fingerprint, the outcome and the result, and never a credential. It is
// written in the same transaction as the work it answers, so a dropped response cannot repeat it.
import { ForgeFailure } from "../../src/contract/failure.ts";
import { canonicalJson } from "../../src/core/config/pointer.ts";
import type { StateOwner } from "../../src/core/state/index.ts";
import type { ForgeError } from "../../src/generated/types.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import { COMMAND_RECEIPTS, DENIAL_BARRIER_ID } from "./dump.ts";

const NAMESPACE = "forge/cloud";
const PREFIX = "request:";
/** Below the paged restore row cap (20,000); legacy receipts do not consume admission. */
export const MAX_RECEIPTS = 3000;
export const PRUNE_RECEIPTS = 8;
export const MAX_LIVE_DENIALS = 4096;
export const RETENTION_MS = 24 * 60 * 60 * 1000;
// Imported audit bytes retain their original expiry; old live rows use the new deadline too.
const DEADLINE = `CASE WHEN imported=0 THEN min(expires_at, created_at+${RETENTION_MS}) ELSE expires_at END`;
const RETRY_UNTIL = `CASE WHEN outcome='refused' THEN expires_at ELSE ${DEADLINE} END`;
export function expiredReplay(refused: boolean): never {
  throw new ForgeFailure({
    code: "INPUT_CONFLICT",
    message: refused
      ? "Request ID remains refused; use a fresh request ID"
      : "Request replay window ended; use a fresh request ID",
    retry: "never",
  });
}
interface Receipt {
  readonly fingerprint: string;
  readonly outcome: "ok" | "refused";
  readonly result: unknown;
}

export function withDenialCapacity<T>(
  db: SqlDatabase,
  expiresAt: number | undefined,
  recheck: () => void,
  work: () => T,
): T {
  const failure = new ForgeFailure({
    code: "UNAVAILABLE",
    message: "Denial capacity is full; existing request ids remain replayable",
    retry: "never",
  });
  let denied = false;
  const value = db.transaction(() => {
    recheck();
    const now = Date.now();
    if (
      typeof expiresAt !== "number" ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= now
    )
      throw new ForgeFailure({
        code: "AUTH_EXPIRED",
        message: "Credential expired before denial admission",
        retry: "never",
      });
    const row = db.get(
      `SELECT EXISTS(SELECT 1 FROM ${COMMAND_RECEIPTS} WHERE request_id=? AND expires_at>?) OR ((SELECT COUNT(*) FROM ${COMMAND_RECEIPTS} WHERE request_id<>? AND imported=0 AND outcome='refused' AND expires_at>?) + (SELECT COUNT(*) FROM domain_cloud_requests WHERE outcome<>'ok' AND COALESCE(json_extract(fingerprint,'$.retryUntil'),9007199254740991)>?))>=? AS saturated`,
      [DENIAL_BARRIER_ID, now, DENIAL_BARRIER_ID, now, now, MAX_LIVE_DENIALS],
    );
    if (Number(row?.saturated) === 0) return work();
    denied = true;
    db.run(
      `INSERT INTO ${COMMAND_RECEIPTS}(request_id,fingerprint,outcome,result,created_at,expires_at) VALUES (?,'{}','refused',?,?,?) ON CONFLICT(request_id) DO UPDATE SET expires_at=MAX(expires_at,excluded.expires_at)`,
      [DENIAL_BARRIER_ID, canonicalJson(failure.error), now, expiresAt],
    );
  });
  if (denied) throw failure;
  return value as T;
}

const full = (db: SqlDatabase, now: number): boolean =>
  Number(
    db.get(
      `SELECT COUNT(*) AS n FROM ${COMMAND_RECEIPTS} WHERE imported=0 AND ${DEADLINE}>?`,
      [now],
    )!.n,
  ) >= MAX_RECEIPTS;

function prune(db: SqlDatabase, now: number): void {
  db.run(
    `DELETE FROM ${COMMAND_RECEIPTS} WHERE request_id IN (SELECT request_id FROM ${COMMAND_RECEIPTS} WHERE ${RETRY_UNTIL}<=? OR (imported=1 AND request_id<>? AND (SELECT COUNT(*) FROM ${COMMAND_RECEIPTS})>=?) ORDER BY ${RETRY_UNTIL}, request_id LIMIT ?)`,
    [now, DENIAL_BARRIER_ID, MAX_RECEIPTS, PRUNE_RECEIPTS],
  );
}

/**
 * The recorded answer for `requestId`, or undefined when the id is fresh. Other input under a
 * recorded id is INPUT_CONFLICT and never replaces the receipt; a recorded refusal is thrown again.
 */
export function replay(
  db: SqlDatabase,
  owner: StateOwner,
  requestId: string,
  fingerprint: string,
): unknown {
  const row = db.get(
    `SELECT fingerprint, outcome, result, created_at, expires_at, ${DEADLINE} AS deadline FROM ${COMMAND_RECEIPTS} WHERE request_id=? AND imported=0`,
    [requestId],
  );
  const now = Date.now();
  if (
    row?.outcome === "refused" &&
    now >= Number(row.deadline) &&
    now < Number(row.expires_at)
  )
    expiredReplay(true);
  if (
    row !== undefined &&
    (now < Number(row.created_at) || now >= Number(row.deadline))
  )
    return undefined;
  const prior =
    row === undefined
      ? (owner.get(NAMESPACE, PREFIX + requestId)?.value as Receipt | undefined)
      : {
          fingerprint: row.fingerprint,
          outcome: row.outcome,
          result: JSON.parse(String(row.result)) as unknown,
        };
  if (prior === undefined) return undefined;
  if (prior.fingerprint !== fingerprint)
    throw new ForgeFailure({
      code: "INPUT_CONFLICT",
      message: "Request ID belongs to a different input",
      retry: "reconcile_first",
    });
  if (prior.outcome === "refused")
    throw new ForgeFailure(prior.result as ForgeError);
  return prior.result;
}

/** Refuses a fresh write when the receipt limit is reached. Runs inside the write's transaction. */
export function admit(db: SqlDatabase): void {
  const now = Date.now();
  prune(db, now);
  if (full(db, now))
    throw new ForgeFailure({
      code: "UNAVAILABLE",
      message:
        "Command receipts are full; the limit clears as token receipts expire",
      retry: "safe",
    });
}

/** Records a receipt and returns its result as stored, so a replay is byte-identical to it. */
export function record(
  db: SqlDatabase,
  requestId: string,
  receipt: Receipt,
  expiresAt: number | undefined,
): unknown {
  const now = Date.now();
  if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt))
    throw new ForgeFailure({
      code: "INTERNAL",
      message: "Command receipt needs a token expiry",
      retry: "never",
    });
  if (expiresAt <= now)
    throw new ForgeFailure({
      code: "AUTH_EXPIRED",
      message: "Token expired before recording the command",
      retry: "never",
    });
  // A retried id may sit behind the bounded prune batch. Replace only its expired live row.
  const stored = db.run(
    `INSERT INTO ${COMMAND_RECEIPTS} (request_id, fingerprint, outcome, result, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(request_id) DO UPDATE SET fingerprint=excluded.fingerprint, outcome=excluded.outcome, result=excluded.result, created_at=excluded.created_at, expires_at=excluded.expires_at WHERE imported=0 AND ${RETRY_UNTIL}<=excluded.created_at`,
    [
      requestId,
      receipt.fingerprint,
      receipt.outcome,
      canonicalJson(receipt.result),
      now,
      receipt.outcome === "refused"
        ? expiresAt
        : Math.min(expiresAt, now + RETENTION_MS),
    ],
  );
  if (stored.changes !== 1)
    throw new ForgeFailure({
      code: "INTERNAL",
      message: "Command receipt was not recorded",
      retry: "never",
    });
  return JSON.parse(
    String(
      db.get(`SELECT result FROM ${COMMAND_RECEIPTS} WHERE request_id=?`, [
        requestId,
      ])!.result,
    ),
  ) as unknown;
}

export function refused(
  db: SqlDatabase,
  requestId: string,
  fingerprint: string,
  failure: ForgeFailure,
  recheck: () => void,
  expiresAt: number | undefined,
): ForgeFailure {
  withDenialCapacity(db, expiresAt, recheck, () => {
    const now = Date.now();
    prune(db, now);
    record(
      db,
      requestId,
      {
        fingerprint,
        outcome: "refused",
        result: failure.error,
      },
      expiresAt,
    );
  });
  return failure;
}
