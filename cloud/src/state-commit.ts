import { ForgeFailure } from "../../src/contract/failure.ts";
import { decideLease } from "../../src/contract/lease.ts";
import { canonicalJson } from "../../src/core/config/pointer.ts";
import type { StateOwner } from "../../src/core/state/index.ts";
import type { StateRecord } from "../../src/generated/types.ts";
import type {
  StateCommitRequest,
  StateCommitResult,
} from "../../src/ports/state-protocol.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import { commandWrite, prepareReceipt } from "./command-write.ts";
import { admitStateWrite } from "./dump.ts";
import type { CommandHost } from "./issue-commands.ts";
import type { ReceiptPrincipal } from "./issue-request-id.ts";
import { MAX_SHOW_RESPONSE_BYTES } from "./issue-read.ts";
import { admitState } from "./state-access.ts";
import { carriesToken } from "./tokens.ts";

interface StateCommitHost extends CommandHost {
  readonly principal: ReceiptPrincipal;
  readonly expiresAt: number;
  readonly epoch: unknown;
  readonly config: () => unknown;
  readonly recheck: () => void;
  readonly open: () => { db: SqlDatabase; owner: StateOwner };
}
const fail = (code: string, message: string): never => {
  throw new ForgeFailure({ code, message, retry: "never" });
};
const envelope = (result: StateCommitResult) => ({
  ok: true,
  status: "OK",
  result,
  warnings: [],
});

/** One state batch and its answer share the existing receipt transaction; no business rules run here. */
export function commitState(
  input: StateCommitRequest,
  host: StateCommitHost,
): Response {
  const recheck = () => {
    host.recheck();
    return admitState(input, host, host.config());
  };
  const admission = recheck();
  if (admission.context.variant !== "project")
    return fail("INTERNAL", "State commit needs project context");
  if (carriesToken(input.requestId))
    return fail("INPUT_INVALID", "requestId must not carry a credential");
  const epoch = host.epoch;
  if (typeof epoch !== "string" || epoch.length === 0 || epoch.length > 128)
    return fail(
      "UNAVAILABLE",
      "Enable cloud project state by issuing an admin device token for this project",
    );
  const { actor } = admission.context;
  // A fence's device/session are token facts; body metadata cannot invent a holder.
  const fence =
    input.fence === undefined
      ? undefined
      : {
          ...input.fence,
          holder: {
            actor,
            session: {
              ...input.context.session,
              id: host.session!,
              device: host.device,
            },
          },
        };
  const { db, owner } = host.open();
  const checkFence = () => {
    if (fence === undefined) return;
    const decision = decideLease(owner.lease(input.namespace, fence.subject), {
      ...fence,
      mode: "held",
      nowMs: Date.now(),
    });
    if (!decision.ok) throw new ForgeFailure(decision.error);
  };
  const checkVersion = () => {
    const revision = owner.namespaceRevision(input.namespace);
    for (const expected of [
      input.readVersion,
      ...input.readSet.map((read) => read.readVersion),
    ])
      if (expected.epoch !== epoch || expected.revision !== revision)
        fail("REVISION_CONFLICT", "State read version changed");
  };
  const identity = prepareReceipt(
    ["state", input.namespace],
    host.principal,
    input.requestId,
    input,
  );
  const resultFor = (
    records: readonly StateRecord[],
    revision: number,
  ): StateCommitResult => ({
    version: 1,
    project: host.project,
    namespace: input.namespace,
    policyRevision: admission.policyRevision,
    requestId: input.requestId,
    records,
    readVersion: { epoch, revision },
    result: null,
  });
  const result = commandWrite(
    db,
    owner,
    {
      identity,
      recheck,
      expiresAt: host.expiresAt,
    },
    () => checkFence(),
    () => {
      // This comparison is inside the outer transaction, immediately before the batch.
      checkVersion();
      const records = owner.putMany(input.namespace, input.entries, actor, {
        readSet: input.readSet.map(({ key, expectRevision }) => ({
          key,
          expectRevision,
        })),
        ...(fence === undefined ? {} : { fence }),
        admit: (records, events) => {
          // SQLite assigns each inserted event the next global sequence, within this transaction.
          const revision =
            Number(
              db.get(
                "SELECT COALESCE(MAX(sequence),0) AS revision FROM state_events",
              )!.revision,
            ) + records.length;
          if (!Number.isSafeInteger(revision))
            fail(
              "UNAVAILABLE",
              "State event sequence exceeds restore admission",
            );
          const value = resultFor(records, revision);
          try {
            admitStateWrite(records, events, {
              request_id: identity.requestId,
              fingerprint: identity.fingerprint,
              outcome: "ok",
              result: canonicalJson(value),
              created_at: Date.now(),
              expires_at: host.expiresAt,
            });
          } catch (error) {
            if (
              error instanceof ForgeFailure &&
              error.error.code === "RESTORE_INVALID_ROW"
            )
              fail("UNAVAILABLE", "State commit exceeds restore admission");
            throw error;
          }
          if (
            new TextEncoder().encode(JSON.stringify(envelope(value))).length >
            MAX_SHOW_RESPONSE_BYTES
          )
            fail("UNAVAILABLE", "State response exceeds the byte budget");
        },
      });
      return resultFor(records, owner.namespaceRevision(input.namespace));
    },
    () => checkFence(),
  );
  return Response.json(envelope(result));
}
