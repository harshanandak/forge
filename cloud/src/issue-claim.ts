// issue.claim at the project authority: the plain exclusive claim. The issue checks, the lease engine's
// own acquisition and the receipt share one transaction, in the local handler's order. A replay returns
// the recorded grant only while it is still the current lease, else LEASE_STALE. Refusals from state
// roll back with the write and are not recorded.
import manifest from "../../src/blocks/work/forge.block.json" with { type: "json" };
import ClaimInput from "../../src/blocks/work/schemas/claim.input.json" with { type: "json" };
import LeaseGrantSchema from "../../src/blocks/work/schemas/LeaseGrant.json" with { type: "json" };
import { ForgeFailure } from "../../src/contract/failure.ts";
import { decideLease } from "../../src/contract/lease.ts";
import { SchemaRegistry } from "../../src/contract/schema.ts";
import type { StateOwner } from "../../src/core/state/index.ts";
import { SCHEMA_DOCUMENTS } from "../../src/generated/schemas.ts";
import type {
  BoundContext,
  LeaseGrant,
  LeaseHolder,
} from "../../src/generated/types.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import {
  checkedValue,
  fail,
  holds,
  minted,
  schemas,
  shownId,
  storedId,
} from "./issue-read.ts";
import { receipted, type WriteCall } from "./issue-write.ts";
import { checkTtl } from "./lease-ttl.ts";

const NAMESPACE = "forge/work";
// The cloud has no claimTtlSeconds setting: the local default applies.
const DEFAULT_TTL_SECONDS = 3600;
const claim = manifest.operations["issue.claim"];
if (
  claim.input !== "schemas/claim.input.json" ||
  claim.output !== "schemas/claim.output.json"
)
  throw new Error("issue.claim no longer declares its input and output");
// claim.input.json is its own root document, so it gets its own registry.
let inputs: SchemaRegistry | undefined;
interface Fields {
  id: string;
  ttlMs: number;
}
interface Edge {
  id: string;
  holder?: LeaseHolder;
  holderUnverified?: true;
}

// The context's actor and session; the route set the session's device from the token.
function holderOf(context: BoundContext): LeaseHolder {
  if (context.variant !== "leased" || context.leaseMode !== "acquire")
    throw fail("INTERNAL", "issue.claim needs an acquire lease context");
  return { actor: context.actor, session: context.session };
}

/** Takes the lease on one issue after the issue checks, or returns the recorded grant while it is still current. */
export function claimIssue(
  db: SqlDatabase,
  owner: StateOwner,
  call: WriteCall,
): LeaseGrant {
  return receipted(
    db,
    owner,
    "issue.claim",
    call,
    (input, prefix): Fields => {
      // Refused by name, never dropped: the blocked-work override is not served yet.
      if (
        typeof input === "object" &&
        input !== null &&
        ("reopen" in input || "reason" in input)
      )
        throw fail(
          "INPUT_INVALID",
          "Reopen and reason are not supported in cloud yet",
        );
      inputs ??= new SchemaRegistry([...SCHEMA_DOCUMENTS, ClaimInput]);
      if (inputs.validate("#", input).length > 0)
        throw fail(
          "INPUT_INVALID",
          "input must be { id, ttlSeconds? } with a valid issue id",
        );
      const { id, ttlSeconds } = input as { id: string; ttlSeconds?: number };
      return {
        id: storedId(id, prefix, minted(db)),
        ttlMs: (ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000,
      };
    },
    ({ id, ttlMs }, _actor, prefix, context) => {
      const holder = holderOf(context);
      const now = Date.now();
      const key = `issue:${id}`;
      // A reservation holds only while its expiry is a future time, as locally.
      const reserved = (
        owner.get(NAMESPACE, `cleanup:${id}`)?.value as
          { expiresAt?: unknown } | undefined
      )?.expiresAt;
      if (typeof reserved === "string" && Date.parse(reserved) > now)
        throw fail(
          "INPUT_CONFLICT",
          `Lane cleanup is in progress; the reservation expires at ${reserved}. Wait until then and retry; no repair is needed`,
        );
      const record = owner.get(NAMESPACE, key);
      if (record === undefined) throw fail("NOT_FOUND", "Issue was not found");
      const value = checkedValue({ ...record }, id);
      if (
        owner.get(NAMESPACE, `slots:${id}`) !== undefined ||
        owner.count(NAMESPACE, `participant:${id}:`) > 0
      )
        throw fail(
          "INPUT_INVALID",
          "Competing and collaborative issues are not yet supported in cloud",
        );
      if (value.status !== "open")
        throw fail("INPUT_CONFLICT", "Closed issues cannot be claimed");
      const dependencies = value.dependsOn.map(
        (dependency) =>
          [dependency, owner.get(NAMESPACE, `issue:${dependency}`)] as const,
      );
      // A live lease goes to the engine first, which refuses with the full holder.
      const blockers = dependencies
        .filter(
          ([, found]) =>
            (found?.value as { status?: unknown } | null | undefined)
              ?.status !== "closed",
        )
        .map(([dependency, found]) => {
          const lease = owner.lease(NAMESPACE, `issue:${dependency}`);
          const edge: Edge = {
            id: shownId(dependency, prefix),
            ...(lease !== undefined && lease.releasedAt === undefined
              ? { holder: lease.holder, holderUnverified: true as const }
              : {}),
          };
          return { edge, state: found === undefined ? "(missing)" : "(open)" };
        });
      if (
        blockers.length > 0 &&
        !holds({ ...owner.lease(NAMESPACE, key) }, now)
      )
        throw new ForgeFailure({
          code: "CLAIM_BLOCKED",
          message: blockers
            .map(({ edge, state }) =>
              [
                edge.id,
                state,
                edge.holder ? JSON.stringify(edge.holder) : "",
              ].join(" "),
            )
            .join(", "),
          retry: "never",
          observed: { blockers: blockers.map(({ edge }) => edge) },
        });
      checkTtl(ttlMs, call.expiresAt);
      // The local handler's read set, so the event records the same basis.
      const readSet = [
        { key, expectRevision: record.revision },
        ...dependencies.map(([dependency, found]) => ({
          key: `issue:${dependency}`,
          expectRevision: found?.revision ?? 0,
        })),
      ];
      const lease = owner.acquire(
        NAMESPACE,
        key,
        holder,
        ttlMs,
        call.requestId,
        { readSet },
      );
      const grant = {
        id: shownId(id, prefix),
        generation: lease.generation,
        expiresAt: lease.expiresAt,
      };
      if (schemas().validate(LeaseGrantSchema.$ref, grant).length > 0)
        throw fail("INTERNAL", "Claim result is not valid");
      return grant;
    },
    (prior, context) => {
      const subject = `issue:work-${prior.id.replace(/^.*-/, "")}`;
      const decision = decideLease(owner.lease(NAMESPACE, subject), {
        mode: "held",
        subject,
        holder: holderOf(context),
        generation: prior.generation,
        nowMs: Date.now(),
      });
      if (!decision.ok)
        throw new ForgeFailure({
          ...decision.error,
          code: "LEASE_STALE",
          message: `Request no longer matches the current lease on ${subject}`,
        });
    },
  );
}
