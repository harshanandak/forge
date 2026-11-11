// issue.create at the project authority. The authority picks the id and writes the issue, its event
// and the command receipt in one transaction. Nothing the caller sends names a key, a namespace or
// an id: the input is checked against the work block's declared schema and only bound as values.
import manifest from "../../src/blocks/work/forge.block.json" with { type: "json" };
import CreateItemInput from "../../src/blocks/work/schemas/CreateItemInput.json" with { type: "json" };
import { ForgeFailure } from "../../src/contract/failure.ts";
import { digestValue } from "../../src/core/config/pointer.ts";
import type { StateOwner } from "../../src/core/state/index.ts";
import type { BoundContext, TrackerItem } from "../../src/generated/types.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import { configured, fail, schemas, shownItem } from "./issue-read.ts";
import { admit, record, refused, replay } from "./issue-receipts.ts";

const NAMESPACE = "forge/work";
const KINDS = ["task", "bug", "feature", "epic"];
const create = manifest.operations["issue.create"];
if (
  create.input !== "schemas/CreateItemInput.json" ||
  create.output !== "schemas/TrackerItem.json"
)
  throw new Error("issue.create no longer declares its input and output");
interface Fields {
  title: string;
  body?: string;
  kind?: string;
  labels?: string[];
}

export interface CreateCall {
  readonly requestId: string;
  readonly input: unknown;
  readonly context: BoundContext;
  /** The device the token names. */
  readonly device: string;
  /** The server's configured id prefix, as set. */
  readonly prefix: unknown;
}

// Parent and dependencies are refused by name, never dropped: the graph arrives in a later slice.
function checked(input: unknown): Fields {
  if (
    typeof input === "object" &&
    input !== null &&
    ("parent" in input || "dependsOn" in input)
  )
    throw fail(
      "INPUT_INVALID",
      "Parent and dependencies are not supported in cloud yet",
    );
  if (schemas().validate(CreateItemInput.$ref, input).length > 0)
    throw fail("INPUT_INVALID", "input must be a valid issue.create input");
  const fields = input as Fields;
  if (fields.kind !== undefined && !KINDS.includes(fields.kind))
    throw fail("INPUT_INVALID", `kind must be one of ${KINDS.join(", ")}`);
  return fields;
}

/**
 * Creates one open issue, or returns the recorded answer for a repeated request. Runs no await, so
 * the caller's token check stays current until the transaction.
 */
export function createIssue(
  db: SqlDatabase,
  owner: StateOwner,
  call: CreateCall,
): TrackerItem {
  const { requestId, input, context, device } = call;
  const prefix = call.prefix as string;
  configured(prefix);
  if (context.variant !== "project")
    throw fail("INTERNAL", "issue.create needs a project context");
  const { actor } = context;
  const fingerprint = digestValue({
    op: "issue.create",
    input,
    context,
    device,
  });
  const prior = replay(owner, requestId, fingerprint);
  if (prior !== undefined) return prior as TrackerItem;
  let fields: Fields;
  try {
    fields = checked(input);
  } catch (error) {
    throw error instanceof ForgeFailure
      ? refused(db, owner, requestId, actor, fingerprint, error)
      : error;
  }
  return db.transaction(() => {
    admit(owner);
    const id = `work-${owner.maxNumber(NAMESPACE, "issue:work-") + 1}`;
    const now = Date.now();
    const written = owner.put(
      NAMESPACE,
      `issue:${id}`,
      {
        id,
        prefix,
        title: fields.title,
        status: "open",
        labels: fields.labels ?? [],
        dependsOn: [],
        createdAt: new Date(now).toISOString(),
        ...(fields.kind ? { kind: fields.kind } : {}),
        ...(fields.body === undefined ? {} : { body: fields.body }),
      },
      actor,
      { expectRevision: 0 },
    );
    const result = shownItem({ ...written }, id, undefined, now, prefix);
    return record(owner, requestId, actor, {
      fingerprint,
      outcome: "ok",
      result,
    }) as TrackerItem;
  });
}
