// issue.comment at the project authority. The authority numbers the comment from its own count inside
// the transaction and writes the comment, its event and the command receipt together. Nothing the
// caller sends names a key or a namespace: the input is checked against the work block's declared
// schema, the id resolves to a stored issue, and the body is only bound as a value.
import manifest from "../../src/blocks/work/forge.block.json" with { type: "json" };
import CommentInput from "../../src/blocks/work/schemas/CommentInput.json" with { type: "json" };
import CommentOutput from "../../src/blocks/work/schemas/CommentOutput.json" with { type: "json" };
import type { StateOwner } from "../../src/core/state/index.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import { fail, minted, schemas, storedId } from "./issue-read.ts";
import { receipted, type WriteCall } from "./issue-write.ts";

const NAMESPACE = "forge/work";
const comment = manifest.operations["issue.comment"];
if (
  comment.input !== "schemas/CommentInput.json" ||
  comment.output !== "schemas/CommentOutput.json"
)
  throw new Error("issue.comment no longer declares its input and output");
export interface Commented {
  id: string;
  commentId: string;
}

/** Adds one comment to an existing issue, or returns the recorded answer for a repeated request. */
export function commentIssue(
  db: SqlDatabase,
  owner: StateOwner,
  call: WriteCall,
): Commented {
  return receipted(
    db,
    owner,
    "issue.comment",
    call,
    (input, prefix) => {
      if (schemas().validate(CommentInput.$ref, input).length > 0)
        throw fail(
          "INPUT_INVALID",
          "input must be { id, body } with a valid issue id and body",
        );
      const { id: given, body } = input as { id: string; body: string };
      const id = storedId(given, prefix, minted(db));
      if (owner.get(NAMESPACE, `issue:${id}`) === undefined)
        throw fail("NOT_FOUND", "Issue was not found");
      return { id, body };
    },
    ({ id, body }, actor, prefix) => {
      const key = `comment:${id}:`;
      const commentId = `${key}${owner.count(NAMESPACE, key) + 1}`;
      owner.put(NAMESPACE, commentId, { id, body }, actor, {
        expectRevision: 0,
      });
      const result = { id: `${prefix}-${id.slice(5)}`, commentId };
      if (schemas().validate(CommentOutput.$ref, result).length > 0)
        throw fail("INTERNAL", "Comment result is not valid");
      return result;
    },
  );
}
