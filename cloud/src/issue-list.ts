// Lists work issues from the state tables and writes nothing. Reads go through the same read-only
// views and fixed statements as show. The scan is bounded before any body is loaded: a project over
// the row or byte budget is refused, never read partly, and never silently shortened. Parity with
// the local list holds within these limits. Only `limit` is supported so far: any other filter
// is refused, never ignored.
import manifest from "../../src/blocks/work/forge.block.json" with { type: "json" };
import type { TrackerItem } from "../../src/generated/types.ts";
import {
  configured,
  fail,
  invalid,
  leaseOf,
  MAX_RECORD_BYTES,
  parseBody,
  ROWS,
  SCAN,
  schemas,
  shownItem,
  type IssueViews,
} from "./issue-read.ts";

export const MAX_SCAN_ROWS = 10_000;
export const MAX_SCAN_BYTES = 8 * 1024 * 1024;
if (manifest.operations["issue.list"].input !== "schemas/ListItemsInput.json")
  throw new Error("issue.list no longer declares schemas/ListItemsInput.json");
if (manifest.operations["issue.list"].output !== "schemas/ListItemsOutput.json")
  throw new Error("issue.list no longer declares schemas/ListItemsOutput.json");

/** The issues in key order, `limit` at most, and whether more were stored than were returned. */
export function listIssues(
  views: IssueViews,
  input: unknown,
  now: number,
  prefix: string,
): { items: TrackerItem[]; truncated: boolean } {
  configured(prefix);
  if (schemas().validate("#", input).length > 0)
    throw fail("INPUT_INVALID", "Invalid issue list input");
  const { limit = 1000, ...filters } = input as { limit?: number };
  if (Object.keys(filters).length > 0)
    throw fail("INPUT_INVALID", "Filter not yet supported in cloud");
  const range = ["forge/work", "issue:", "issue;", MAX_SCAN_ROWS + 1];
  const sizes = views.records?.all(SCAN, range) ?? [];
  if (
    sizes.length > MAX_SCAN_ROWS ||
    sizes.reduce((sum, row) => sum + Number(row.size), 0) > MAX_SCAN_BYTES
  )
    throw fail("UNAVAILABLE", "Issue list is over its read budget");
  if (sizes.some((row) => Number(row.size) > MAX_RECORD_BYTES)) throw invalid();
  const rows = views.records?.all(ROWS, range) ?? [];
  if (rows.length !== sizes.length) throw invalid();
  // Every row is parsed and checked (identity, schema) before any lease is read, even past `limit`.
  const records = rows.map((row) => parseBody(row.body, MAX_RECORD_BYTES));
  const ids = rows.map((row) => String(row.key).slice("issue:".length));
  records.forEach((record, at) =>
    shownItem(record, ids[at]!, undefined, now, prefix),
  );
  return {
    items: records
      .slice(0, limit)
      .map((record, at) =>
        shownItem(record, ids[at]!, leaseOf(views, ids[at]!), now, prefix),
      ),
    truncated: records.length > limit,
  };
}
