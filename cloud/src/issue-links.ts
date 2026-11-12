// Reads one issue's links and writes nothing, through the shared appended-record reader.
import manifest from "../../src/blocks/work/forge.block.json" with { type: "json" };
import { listAppendedRecords } from "./issue-appended.ts";
import type { IssueViews } from "./issue-read.ts";

const links = manifest.operations["issue.links"];
if (
  links.input !== "schemas/ItemRef.json" ||
  links.output !== "schemas/records.json"
)
  throw new Error("issue.links no longer declares its input and output");

/** The issue's link records in link-number order: the key order first, then a stable sort on the number each key ends with. */
export function listLinks(
  views: IssueViews,
  input: unknown,
  _now: number,
  prefix: string,
): { records: object[] } {
  return listAppendedRecords(views, input, prefix, {
    key: "link",
    overBudgetMessage: "Issue links are over their read budget",
  });
}
