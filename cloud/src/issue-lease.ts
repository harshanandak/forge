// issue.renew and issue.release at the project authority, for the caller that holds the issue's live
// lease. The server resolves the issue id to its subject, so the caller never supplies one, and the
// issue check, the lease engine's held-lease fence and the receipt share one transaction, in the local
// handler's order. A release that committed replays its original result: it grants nothing, and the
// fingerprint already binds the caller. A renew replays only while its exact grant is still the live
// lease, else LEASE_STALE. Refusals from state roll back with the write and are not recorded.
import manifest from "../../src/blocks/work/forge.block.json" with { type: "json" };
import ClaimInput from "../../src/blocks/work/schemas/ClaimInput.json" with { type: "json" };
import ItemRef from "../../src/blocks/work/schemas/ItemRef.json" with { type: "json" };
import LeaseGrantSchema from "../../src/blocks/work/schemas/LeaseGrant.json" with { type: "json" };
import { ForgeFailure } from "../../src/contract/failure.ts";
import { decideLease } from "../../src/contract/lease.ts";
import type { StateOwner } from "../../src/core/state/index.ts";
import type { BoundContext, LeaseGrant } from "../../src/generated/types.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import { fail, minted, schemas, shownId, storedId } from "./issue-read.ts";
import { fence } from "./issue-update.ts";
import { receipted, type WriteCall } from "./issue-write.ts";
import { checkTtl } from "./lease-ttl.ts";

const NAMESPACE = "forge/work";
// The cloud has no claimTtlSeconds setting: the local default applies.
const DEFAULT_TTL_SECONDS = 3600;
const { "issue.renew": renew, "issue.release": release } = manifest.operations;
if (
  renew.input !== "schemas/ClaimInput.json" ||
  renew.output !== "schemas/LeaseGrant.json" ||
  release.input !== "schemas/ItemRef.json" ||
  release.output !== "schemas/ItemRef.json"
)
  throw new Error(
    "issue.renew or issue.release no longer declares its schemas",
  );
interface Fields {
  id: string;
  /** The id as the caller wrote it, which the local message for a missing issue repeats. */
  given: string;
  ttlMs: number;
}

// The id the caller wrote, resolved to its stored id; a shape the schema refuses is a recorded refusal.
function resolved(
  db: SqlDatabase,
  input: unknown,
  prefix: string,
  schema: { $ref: string },
  shape: string,
): Fields {
  if (schemas().validate(schema.$ref, input).length > 0)
    throw fail("INPUT_INVALID", `input must be ${shape} with a valid issue id`);
  const { id, ttlSeconds } = input as { id: string; ttlSeconds?: number };
  return {
    id: storedId(id, prefix, minted(db)),
    given: id,
    ttlMs: (ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000,
  };
}

// The fence for the issue, once it exists: the caller's holder and generation, the device from the token.
function target(
  owner: StateOwner,
  context: BoundContext,
  op: string,
  { id, given }: Fields,
) {
  const held = fence(context, id, op);
  if (owner.get(NAMESPACE, held.subject) === undefined)
    throw fail("NOT_FOUND", `Issue ${given} was not found`);
  return held;
}

/** Extends the lease the caller holds on one issue, or returns the recorded grant while it is still the live lease. */
export function renewIssue(
  db: SqlDatabase,
  owner: StateOwner,
  call: WriteCall,
): LeaseGrant {
  return receipted(
    db,
    owner,
    "issue.renew",
    call,
    (input, prefix) =>
      resolved(db, input, prefix, ClaimInput, "{ id, ttlSeconds? }"),
    (fields, _actor, prefix, context) => {
      const held = target(owner, context, "issue.renew", fields);
      // Before the engine, as the raw renew route does; the local handler has no cap.
      checkTtl(fields.ttlMs, call.expiresAt);
      const lease = owner.renew(NAMESPACE, held, fields.ttlMs);
      const grant = {
        id: shownId(fields.id, prefix),
        generation: lease.generation,
        expiresAt: lease.expiresAt,
      };
      if (schemas().validate(LeaseGrantSchema.$ref, grant).length > 0)
        throw fail("INTERNAL", "Renew result is not valid");
      return grant;
    },
    (prior, context) => {
      const held = fence(
        context,
        `work-${prior.id.replace(/^.*-/, "")}`,
        "issue.renew",
      );
      const current = owner.lease(NAMESPACE, held.subject);
      // The recorded grant is the live lease only while it is held and not renewed since.
      if (
        decideLease(current, { mode: "held", ...held, nowMs: Date.now() }).ok &&
        current?.expiresAt === prior.expiresAt
      )
        return;
      throw new ForgeFailure({
        code: "LEASE_STALE",
        message: `Request no longer matches the current lease on ${held.subject}`,
        retry: "reconcile_first",
        lease:
          current === undefined
            ? { subject: held.subject }
            : {
                subject: held.subject,
                holder: current.holder,
                generation: current.generation,
                expiresAt: current.expiresAt,
              },
      });
    },
  );
}

/** Gives up the lease the caller holds on one issue, or returns the recorded result after a release that committed. */
export function releaseIssue(
  db: SqlDatabase,
  owner: StateOwner,
  call: WriteCall,
): { id: string } {
  return receipted(
    db,
    owner,
    "issue.release",
    call,
    (input, prefix) => resolved(db, input, prefix, ItemRef, "{ id }"),
    (fields, _actor, prefix, context) => {
      owner.release(NAMESPACE, target(owner, context, "issue.release", fields));
      return { id: shownId(fields.id, prefix) };
    },
    // The lease is gone after a release, and the answer grants nothing: the receipt replays as recorded.
    () => {},
  );
}
