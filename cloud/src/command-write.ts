// Shared replay and receipt transaction for synchronous writes at the project authority.
import { ForgeFailure } from "../../src/contract/failure.ts";
import { canonicalJson, digestValue } from "../../src/core/config/pointer.ts";
import type { StateOwner } from "../../src/core/state/index.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import { admit, record, refused, replay } from "./issue-receipts.ts";
import {
  receiptScope,
  scopeRequestId,
  type ReceiptPrincipal,
} from "./issue-request-id.ts";

class ReceiptIdentity {
  readonly #bytes: { readonly requestId: string; readonly fingerprint: string };
  constructor(
    family: "command" | "lease",
    principal: ReceiptPrincipal,
    raw: string,
    input: unknown,
  ) {
    this.#bytes = {
      requestId: scopeRequestId(family, principal, raw),
      fingerprint: canonicalJson({
        scope: receiptScope(principal),
        input: digestValue(input),
      }),
    };
    Object.freeze(this);
  }
  get requestId(): string {
    return this.#bytes.requestId;
  }
  get fingerprint(): string {
    return this.#bytes.fingerprint;
  }
}

/** Principal and transport family come from the server, never from the request body. */
export function prepareReceipt(
  family: "command" | "lease",
  principal: ReceiptPrincipal,
  raw: string,
  input: unknown,
): ReceiptIdentity {
  return new ReceiptIdentity(family, principal, raw, input);
}

export interface CommandWriteCall {
  readonly identity: ReceiptIdentity;
  readonly recheck: () => void;
  readonly expiresAt: number | undefined;
}

/**
 * Authenticates before replay, then checks fresh input. Typed input refusals are recorded separately;
 * successful work and its receipt share one transaction, after token recheck and receipt admission.
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
  const {
    identity: { requestId, fingerprint },
    recheck,
    expiresAt,
  } = call;
  recheck();
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
