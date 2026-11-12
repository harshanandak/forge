// Reads one issue's comments and writes nothing, through the shared appended-record reader.
import manifest from "../../src/blocks/work/forge.block.json" with { type: "json" };
import { listAppendedRecords } from "./issue-appended.ts";
import type { IssueViews } from "./issue-read.ts";

const comments = manifest.operations["issue.comments"];
if (
  comments.input !== "schemas/ItemRef.json" ||
  comments.output !== "schemas/records.json"
)
  throw new Error("issue.comments no longer declares its input and output");

/** The issue's comment records in append order: the key order first, then a stable sort on the number each key ends with. */
export function listComments(
  views: IssueViews,
  input: unknown,
  _now: number,
  prefix: string,
): { records: object[] } {
  return listAppendedRecords(views, input, prefix, {
    key: "comment",
    overBudgetMessage: "Issue comments are over their read budget",
  });
}
