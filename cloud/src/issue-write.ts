// Issue-specific configuration, input and lease guards around the shared receipt transaction.
import { canonicalJson, digestValue } from "../../src/core/config/pointer.ts";
import type { StateOwner } from "../../src/core/state/index.ts";
import type { Actor, BoundContext } from "../../src/generated/types.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import { commandWrite } from "./command-write.ts";
import { configured, fail } from "./issue-read.ts";
import { carriesToken } from "./tokens.ts";
import type { ReceiptScope } from "./issue-request-id.ts";

export interface WriteCall {
  readonly scope: ReceiptScope;
  readonly requestId: string;
  readonly input: unknown;
  readonly context: BoundContext;
  /** The device the token names. */
  readonly device: string;
  /** The server's configured id prefix, as set. */
  readonly prefix: unknown;
  /** Throws AUTH_EXPIRED or AUTH_REVOKED when the token is no longer valid. */
  readonly recheck: () => void;
  /** Token expiry bounds receipt retention and any lease this write takes. */
  readonly expiresAt: number | undefined;
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
  const fingerprint = canonicalJson({
    scope: call.scope,
    input: digestValue({ op, input, context, device }),
  });
  return commandWrite(
    db,
    owner,
    { requestId, fingerprint, recheck, expiresAt: call.expiresAt },
    () => check(input, prefix),
    (fields) => write(fields, actor, prefix, context),
    replayed === undefined ? undefined : (prior) => replayed(prior, context),
  );
}
