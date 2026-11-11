// Typed command receipts at the project authority: namespace forge/cloud, key request:<requestId>.
// A receipt holds the input fingerprint, the outcome and the result, and never a credential. It is
// written in the same transaction as the work it answers, so a dropped response cannot repeat it.
import { ForgeFailure } from "../../src/contract/failure.ts";
import type { StateOwner } from "../../src/core/state/index.ts";
import type { Actor, ForgeError } from "../../src/generated/types.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";

const NAMESPACE = "forge/cloud";
const PREFIX = "request:";
/** The most receipts, refusals included, one project keeps. Past it a fresh write is refused. */
export const MAX_RECEIPTS = 3000;
interface Receipt {
  readonly fingerprint: string;
  readonly outcome: "ok" | "refused";
  readonly result: unknown;
}

const full = (owner: StateOwner): boolean =>
  owner.count(NAMESPACE, PREFIX) >= MAX_RECEIPTS;

/**
 * The recorded answer for `requestId`, or undefined when the id is fresh. Other input under a
 * recorded id is INPUT_CONFLICT and never replaces the receipt; a recorded refusal is thrown again.
 */
export function replay(
  owner: StateOwner,
  requestId: string,
  fingerprint: string,
): unknown {
  const prior = owner.get(NAMESPACE, PREFIX + requestId)?.value as
    Receipt | undefined;
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
export function admit(owner: StateOwner): void {
  if (full(owner))
    throw new ForgeFailure({
      code: "UNAVAILABLE",
      message: "Command receipts are full for this project",
      retry: "never",
    });
}

/** Records a receipt and returns its result as stored, so a replay is byte-identical to it. */
export function record(
  owner: StateOwner,
  requestId: string,
  actor: Actor,
  receipt: Receipt,
): unknown {
  const key = PREFIX + requestId;
  owner.put(NAMESPACE, key, receipt, actor, { expectRevision: 0 });
  return (owner.get(NAMESPACE, key)!.value as Receipt).result;
}

/**
 * Records a typed refusal in its own transaction, after no work was written, and returns it to be
 * thrown. Past the receipt limit the refusal is returned unrecorded.
 */
export function refused(
  db: SqlDatabase,
  owner: StateOwner,
  requestId: string,
  actor: Actor,
  fingerprint: string,
  failure: ForgeFailure,
): ForgeFailure {
  if (!full(owner))
    db.transaction(() =>
      record(owner, requestId, actor, {
        fingerprint,
        outcome: "refused",
        result: failure.error,
      }),
    );
  return failure;
}
