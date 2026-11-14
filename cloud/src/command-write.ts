// Shared replay and receipt transaction for synchronous writes at the project authority.
import { ForgeFailure } from "../../src/contract/failure.ts";
import type { StateOwner } from "../../src/core/state/index.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import { admit, record, refused, replay } from "./issue-receipts.ts";

export interface CommandWriteCall {
  readonly requestId: string;
  readonly fingerprint: string;
  readonly recheck: () => void;
  readonly expiresAt: number | undefined;
}

/**
 * Replays before checking input. Typed input refusals are recorded separately; successful work
 * and its receipt share one transaction, after the token recheck and receipt admission.
 * The caller supplies any domain guard that must run before returning a replayed result.
 */
export function commandWrite<Fields, Result>(
  db: SqlDatabase,
  owner: StateOwner,
  call: CommandWriteCall,
  check: () => Fields,
  write: (fields: Fields) => Result,
  replayed?: (prior: Result) => void,
): Result {
  const { requestId, fingerprint, recheck, expiresAt } = call;
  const prior = replay(db, owner, requestId, fingerprint);
  if (prior !== undefined) {
    replayed?.(prior as Result);
    return prior as Result;
  }
  let fields: Fields;
  try {
    fields = check();
  } catch (error) {
    throw error instanceof ForgeFailure
      ? refused(db, requestId, fingerprint, error, recheck, expiresAt)
      : error;
  }
  return db.transaction(() => {
    // No await separates this token check from the work and receipt commit.
    recheck();
    admit(db);
    return record(
      db,
      requestId,
      { fingerprint, outcome: "ok", result: write(fields) },
      expiresAt,
    ) as Result;
  });
}
