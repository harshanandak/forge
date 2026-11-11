// One receipted write at the project authority, shared by every command that writes: the request id is
// refused when it carries a credential, a repeated request is answered from its receipt, input that
// fails its check is recorded as a refusal, and the recheck, admission, work and receipt share one
// transaction. A command supplies only its own check and its own write.
import { ForgeFailure } from "../../src/contract/failure.ts";
import { digestValue } from "../../src/core/config/pointer.ts";
import type { StateOwner } from "../../src/core/state/index.ts";
import type { Actor, BoundContext } from "../../src/generated/types.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import { configured, fail } from "./issue-read.ts";
import { admit, record, refused, replay } from "./issue-receipts.ts";
import { carriesToken } from "./tokens.ts";

export interface WriteCall {
  readonly requestId: string;
  readonly input: unknown;
  readonly context: BoundContext;
  /** The device the token names. */
  readonly device: string;
  /** The server's configured id prefix, as set. */
  readonly prefix: unknown;
  /** Throws AUTH_EXPIRED or AUTH_REVOKED when the token is no longer valid. */
  readonly recheck: () => void;
}

/**
 * Runs `write` once per request id and returns the recorded answer for a repeat. `check` throws
 * ForgeFailure for input it refuses; that refusal is recorded. Runs no await, and rechecks the token
 * inside the transaction before `write` allocates anything. A leased write passes `replayed`, which
 * rechecks the lease before a recorded answer is returned and makes the call take a held-lease context;
 * without it the call takes a project context.
 */
export function receipted<Fields, Result>(
  db: SqlDatabase,
  owner: StateOwner,
  op: string,
  call: WriteCall,
  check: (input: unknown, prefix: string) => Fields,
  write: (
    fields: Fields,
    actor: Actor,
    prefix: string,
    context: BoundContext,
  ) => Result,
  replayed?: (prior: Result, context: BoundContext) => void,
): Result {
  const { requestId, input, context, device, recheck } = call;
  // The id becomes a receipt key, an event and a dump row, so a credential is never taken as an id.
  if (carriesToken(requestId))
    throw fail("INPUT_INVALID", "requestId must not carry a credential");
  const prefix = call.prefix as string;
  configured(prefix);
  const variant = replayed === undefined ? "project" : "leased";
  if (context.variant !== variant)
    throw fail("INTERNAL", `${op} needs a ${variant} context`);
  const { actor } = context;
  const fingerprint = digestValue({ op, input, context, device });
  const prior = replay(owner, requestId, fingerprint);
  if (prior !== undefined) {
    replayed?.(prior as Result, context);
    return prior as Result;
  }
  let fields: Fields;
  try {
    fields = check(input, prefix);
  } catch (error) {
    throw error instanceof ForgeFailure
      ? refused(db, owner, requestId, actor, fingerprint, error, recheck)
      : error;
  }
  return db.transaction(() => {
    // The token may have expired or been revoked since the route's check: nothing is written then.
    recheck();
    admit(owner);
    return record(owner, requestId, actor, {
      fingerprint,
      outcome: "ok",
      result: write(fields, actor, prefix, context),
    }) as Result;
  });
}
