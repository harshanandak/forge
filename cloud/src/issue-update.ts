// issue.update at the project authority, for a caller that holds the issue's live lease. Title, body
// and labels are the only fields: kind, parent and dependencies are refused by name, and an issue keeps
// what it has. The state owner fences the write to the caller's device, session and lease generation,
// then to the expected revision, inside the transaction that also writes the event and the receipt.
// A replay checks the lease again, so a device that lost it never gets the old result back.
import manifest from "../../src/blocks/work/forge.block.json" with { type: "json" };
import UpdateItemInput from "../../src/blocks/work/schemas/UpdateItemInput.json" with { type: "json" };
import { ForgeFailure } from "../../src/contract/failure.ts";
import { decideLease } from "../../src/contract/lease.ts";
import type { StateOwner } from "../../src/core/state/index.ts";
import type { BoundContext, TrackerItem } from "../../src/generated/types.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import {
  checkedValue,
  fail,
  minted,
  schemas,
  shownItem,
  storedId,
} from "./issue-read.ts";
import { receipted, type WriteCall } from "./issue-write.ts";

const NAMESPACE = "forge/work";
const update = manifest.operations["issue.update"];
if (
  update.input !== "schemas/UpdateItemInput.json" ||
  update.output !== "schemas/TrackerItem.json"
)
  throw new Error("issue.update no longer declares its input and output");
interface Fields {
  id: string;
  expectRevision: number;
  patch: { title?: string; body?: string; labels?: string[] };
}

// The fence a held-lease context names: the caller's holder and generation, the device from the token.
// Shared by every command that holds a lease on one issue.
export function fence(context: BoundContext, id: string, op: string) {
  if (context.variant !== "leased" || context.leaseMode !== "held")
    throw fail("INTERNAL", `${op} needs a held lease context`);
  return {
    subject: `issue:${id}`,
    holder: { actor: context.actor, session: context.session },
    generation: context.leaseGeneration,
  };
}

/** The written issue as the local command shows it, with the caller's lease while it is live. */
export function shownWrite(
  owner: StateOwner,
  written: ReturnType<StateOwner["put"]>,
  id: string,
  prefix: string,
): TrackerItem {
  const lease = owner.lease(NAMESPACE, `issue:${id}`);
  return shownItem(
    { ...written },
    id,
    lease === undefined ? undefined : { ...lease },
    Date.now(),
    prefix,
  );
}

/** The replay hook of a write that returns an issue: the recorded item comes back only while the caller still holds its lease. */
export const heldReplay =
  (owner: StateOwner, op: string) =>
  (prior: TrackerItem, context: BoundContext): void => {
    const held = fence(context, `work-${prior.id.replace(/^.*-/, "")}`, op);
    const decision = decideLease(owner.lease(NAMESPACE, held.subject), {
      mode: "held",
      subject: held.subject,
      holder: held.holder,
      generation: held.generation,
      nowMs: Date.now(),
    });
    if (!decision.ok)
      throw new ForgeFailure({
        ...decision.error,
        code: "LEASE_STALE",
        message: `Request no longer matches the current lease on ${held.subject}`,
      });
  };

/** Edits one issue's title, body or labels, or returns the recorded answer while the caller still holds its lease. */
export function updateIssue(
  db: SqlDatabase,
  owner: StateOwner,
  call: WriteCall,
): TrackerItem {
  return receipted(
    db,
    owner,
    "issue.update",
    call,
    (input, prefix): Fields => {
      // Graph fields are refused by name, never dropped: the graph arrives in a later slice.
      if (
        typeof input === "object" &&
        input !== null &&
        ("kind" in input || "parent" in input || "dependsOn" in input)
      )
        throw fail(
          "INPUT_INVALID",
          "Kind, parent and dependencies are not supported in cloud yet",
        );
      if (schemas().validate(UpdateItemInput.$ref, input).length > 0)
        throw fail("INPUT_INVALID", "input must be a valid issue.update input");
      const {
        id: given,
        expectRevision,
        ...patch
      } = input as Fields["patch"] & { id: string; expectRevision: number };
      const id = storedId(given, prefix, minted(db));
      if (owner.get(NAMESPACE, `issue:${id}`) === undefined)
        throw fail("NOT_FOUND", "Issue was not found");
      return { id, expectRevision, patch };
    },
    ({ id, expectRevision, patch }, actor, prefix, context) => {
      const key = `issue:${id}`;
      const current = checkedValue({ ...owner.get(NAMESPACE, key)! }, id);
      const written = owner.put(
        NAMESPACE,
        key,
        { ...current, ...patch },
        actor,
        {
          expectRevision,
          fence: fence(context, id, "issue.update"),
        },
      );
      return shownWrite(owner, written, id, prefix);
    },
    heldReplay(owner, "issue.update"),
  );
}
