// issue.update at the project authority, for a caller that holds the issue's live lease. Title, body
// and labels are the only fields: kind, parent and dependencies are refused by name, and an issue keeps
// what it has. The state owner fences the write to the caller's device, session and lease generation,
// then to the expected revision, inside the transaction that also writes the event and the receipt.
// A replay checks the lease again, so a device that lost it never gets the old result back.
import manifest from "../../src/blocks/work/forge.block.json" with { type: "json" };
import UpdateItemInput from "../../src/blocks/work/schemas/UpdateItemInput.json" with { type: "json" };
import { normalizeFileDeclarations } from "../../src/blocks/work/file-declarations.ts";
import { ForgeFailure } from "../../src/contract/failure.ts";
import { decideLease } from "../../src/contract/lease.ts";
import type { StateOwner } from "../../src/core/state/index.ts";
import type {
  BoundContext,
  TrackerItem,
  UpdateItemInput as UpdateInput,
} from "../../src/generated/types.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import {
  checkedValue,
  fail,
  minted,
  schemas,
  shownItem,
  storedId,
} from "./issue-read.ts";
import {
  boundedResult,
  checkFileDeclarationBudget,
  receipted,
  type WriteCall,
} from "./issue-write.ts";

const NAMESPACE = "forge/work";
export const UPDATE_GRAPH =
  "Kind, parent and dependencies are not supported in cloud yet";
export const UPDATE_SCHEMA = "input must be a valid issue.update input";
const update = manifest.operations["issue.update"];
if (
  update.input !== "schemas/UpdateItemInput.json" ||
  update.output !== "schemas/TrackerItem.json"
)
  throw new Error("issue.update no longer declares its input and output");
type Editable = Omit<UpdateInput, "kind" | "parent" | "dependsOn">;
type Fields = {
  id: string;
  expectRevision: number;
  patch: Omit<Editable, "id" | "expectRevision">;
};

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

/** The replay decision for stored issue `id`: LEASE_STALE unless the caller still holds its live lease at the original generation. */
export function heldLease(
  owner: StateOwner,
  context: BoundContext,
  id: string,
  op: string,
): void {
  const held = fence(context, id, op);
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
}

/** The replay hook of a write that returns an issue: the recorded item comes back only while the caller still holds its lease. */
export const heldReplay =
  (owner: StateOwner, op: string) =>
  (prior: TrackerItem, context: BoundContext): void =>
    heldLease(owner, context, `work-${prior.id.replace(/^.*-/, "")}`, op);

export function checkedUpdateInput(input: unknown) {
  if (
    typeof input === "object" &&
    input !== null &&
    ("kind" in input || "parent" in input || "dependsOn" in input)
  )
    throw fail("INPUT_INVALID", UPDATE_GRAPH);
  if (schemas().validate(UpdateItemInput.$ref, input).length > 0)
    throw fail("INPUT_INVALID", UPDATE_SCHEMA);
  const fields = input as Editable;
  const declarations = normalizeFileDeclarations(fields);
  if (!declarations.ok) throw fail("INPUT_INVALID", declarations.message);
  return { ...fields, ...declarations.patch };
}

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
      const { id: given, expectRevision, ...patch } = checkedUpdateInput(input);
      const id = storedId(given, prefix, minted(db));
      if (owner.get(NAMESPACE, `issue:${id}`) === undefined)
        throw fail("NOT_FOUND", "Issue was not found");
      return { id, expectRevision, patch };
    },
    ({ id, expectRevision, patch }, actor, prefix, context) => {
      const key = `issue:${id}`;
      const current = checkedValue({ ...owner.get(NAMESPACE, key)! }, id);
      const value = { ...current, ...patch };
      const written = owner.put(NAMESPACE, key, value, actor, {
        expectRevision,
        fence: fence(context, id, "issue.update"),
      });
      checkFileDeclarationBudget(value);
      return boundedResult(
        "issue.update",
        shownWrite(owner, written, id, prefix),
      );
    },
    heldReplay(owner, "issue.update"),
  );
}
