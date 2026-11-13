// Typed command receipts are server data; legacy evented records stay frozen in forge/cloud.
// A receipt holds the input fingerprint, the outcome and the result, and never a credential. It is
// written in the same transaction as the work it answers, so a dropped response cannot repeat it.
import { ForgeFailure } from "../../src/contract/failure.ts";
import { canonicalJson } from "../../src/core/config/pointer.ts";
import type { StateOwner } from "../../src/core/state/index.ts";
import type { ForgeError } from "../../src/generated/types.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import { COMMAND_RECEIPTS } from "./dump.ts";

const NAMESPACE = "forge/cloud";
const PREFIX = "request:";
/** Below the paged restore row cap (20,000); legacy receipts do not consume admission. */
export const MAX_RECEIPTS = 3000;
export const PRUNE_RECEIPTS = 8;
interface Receipt {
  readonly fingerprint: string;
  readonly outcome: "ok" | "refused";
  readonly result: unknown;
}

const full = (db: SqlDatabase, now: number): boolean =>
  Number(
    db.get(`SELECT COUNT(*) AS n FROM ${COMMAND_RECEIPTS} WHERE expires_at>?`, [
      now,
    ])!.n,
  ) >= MAX_RECEIPTS;

function prune(db: SqlDatabase, now: number): void {
  // Authentication precedes lookup and token identities cannot renew: expired rows have no caller.
  db.run(
    `DELETE FROM ${COMMAND_RECEIPTS} WHERE request_id IN (SELECT request_id FROM ${COMMAND_RECEIPTS} WHERE expires_at<=? ORDER BY expires_at, request_id LIMIT ?)`,
    [now, PRUNE_RECEIPTS],
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
    `SELECT fingerprint, outcome, result FROM ${COMMAND_RECEIPTS} WHERE request_id=?`,
    [requestId],
  );
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
  if (!Number.isSafeInteger(expiresAt))
    throw new ForgeFailure({
      code: "INTERNAL",
      message: "Command receipt needs a token expiry",
      retry: "never",
    });
  if (expiresAt! <= now)
    throw new ForgeFailure({
      code: "AUTH_EXPIRED",
      message: "Token expired before recording the command",
      retry: "never",
    });
  db.run(
    `INSERT INTO ${COMMAND_RECEIPTS} (request_id, fingerprint, outcome, result, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      requestId,
      receipt.fingerprint,
      receipt.outcome,
      canonicalJson(receipt.result),
      now,
      expiresAt!,
    ],
  );
  return JSON.parse(
    String(
      db.get(`SELECT result FROM ${COMMAND_RECEIPTS} WHERE request_id=?`, [
        requestId,
      ])!.result,
    ),
  ) as unknown;
}

/**
 * Records a typed refusal in its own transaction, after no work was written, and returns it to be
 * thrown. Past the receipt limit the refusal is returned unrecorded. `recheck` runs first inside the
 * transaction and throws when the token is no longer valid.
 */
export function refused(
  db: SqlDatabase,
  requestId: string,
  fingerprint: string,
  failure: ForgeFailure,
  recheck: () => void,
  expiresAt: number | undefined,
): ForgeFailure {
  db.transaction(() => {
    // An expired or revoked token records nothing.
    recheck();
    const now = Date.now();
    prune(db, now);
    if (!full(db, now))
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
