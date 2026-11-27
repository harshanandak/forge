// issue.create at the project authority. The authority picks the id and writes the issue, its event
// and the command receipt in one transaction. Nothing the caller sends names a key, a namespace or
// an id: the input is checked against the work block's declared schema and only bound as values.
import manifest from "../../src/blocks/work/forge.block.json" with { type: "json" };
import CreateItemInput from "../../src/blocks/work/schemas/CreateItemInput.json" with { type: "json" };
import { normalizeFileDeclarations } from "../../src/blocks/work/file-declarations.ts";
import type { StateOwner } from "../../src/core/state/index.ts";
import type { TrackerItem } from "../../src/generated/types.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import { fail, schemas, shownItem } from "./issue-read.ts";
import { boundedResult, receipted, type WriteCall } from "./issue-write.ts";

const NAMESPACE = "forge/work";
const FLOOR_MISSING =
  "This project has issue history but no saved issue number, so creating issues is not available for it yet";
const KINDS = ["task", "bug", "feature", "epic"];
export const CREATE_GRAPH =
  "Parent and dependencies are not supported in cloud yet";
export const CREATE_SCHEMA = "input must be a valid issue.create input";
export const KIND_REFUSED = `kind must be one of ${KINDS.join(", ")}`;
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
  expectedFiles?: readonly string[];
}

// Parent and dependencies are refused by name, never dropped: the graph arrives in a later slice.
export function checked(input: unknown): Fields {
  if (
    typeof input === "object" &&
    input !== null &&
    ("parent" in input || "dependsOn" in input)
  )
    throw fail("INPUT_INVALID", CREATE_GRAPH);
  if (schemas().validate(CreateItemInput.$ref, input).length > 0)
    throw fail("INPUT_INVALID", CREATE_SCHEMA);
  const fields = input as Fields;
  if (fields.kind !== undefined && !KINDS.includes(fields.kind))
    throw fail("INPUT_INVALID", KIND_REFUSED);
  const declarations = normalizeFileDeclarations(input, ["expectedFiles"]);
  if (!declarations.ok) throw fail("INPUT_INVALID", declarations.message);
  return { ...fields, ...declarations.patch };
}

/** Creates one open issue, or returns the recorded answer for a repeated request. */
export function createIssue(
  db: SqlDatabase,
  owner: StateOwner,
  call: WriteCall,
): TrackerItem {
  return receipted(
    db,
    owner,
    "issue.create",
    call,
    checked,
    (fields, actor, prefix) => {
      const now = Date.now();
      const written = owner.putNext(
        NAMESPACE,
        "issue:work-",
        (_key, number) => {
          const id = `work-${number}`;
          return {
            value: {
              id,
              prefix,
              title: fields.title,
              status: "open",
              labels: fields.labels ?? [],
              dependsOn: [],
              createdAt: new Date(now).toISOString(),
              ...(fields.kind ? { kind: fields.kind } : {}),
              ...(fields.body === undefined ? {} : { body: fields.body }),
              ...(fields.expectedFiles === undefined
                ? {}
                : { expectedFiles: fields.expectedFiles }),
            },
          };
        },
        actor,
        { refuseMissing: FLOOR_MISSING },
      );
      const id = `work-${written.key.slice("issue:work-".length)}`;
      return boundedResult(
        "issue.create",
        shownItem({ ...written }, id, undefined, now, prefix),
      );
    },
  );
}
