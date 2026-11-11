// Lists work issues from the state tables and writes nothing. Reads go through the same read-only
// views and fixed statements as show. The scan is bounded before any body is loaded: a project over
// the row or byte budget is refused, never read partly, and never silently shortened. Parity with
// the local list holds within these limits. Every row is checked before any filter, limit or lease
// read; a lease is read only for an issue that is still a candidate.
import manifest from "../../src/blocks/work/forge.block.json" with { type: "json" };
import type { TrackerItem } from "../../src/generated/types.ts";
import {
  configured,
  fail,
  holdsLease,
  invalid,
  leaseOf,
  MAX_RECORD_BYTES,
  parseBody,
  ROWS,
  SCAN,
  schemas,
  shownItem,
  storedId,
  type IssueViews,
} from "./issue-read.ts";

type Input = {
  parent?: string;
  kind?: string;
  label?: string[];
  labels?: string[];
  status?: string;
  createdSince?: string;
  ready?: boolean;
  limit?: number;
};
type Stored = {
  status: string;
  kind?: string;
  parent?: string;
  labels: string[];
  createdAt: string;
  dependsOn: string[];
  prefix?: unknown;
};

/** Ready mode: open, unblocked, unleased issues only, ranked by `labelOrder`. */
export type ReadyMode = { readonly labelOrder: readonly string[] };
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
  _ready?: ReadyMode,
): { items: TrackerItem[]; truncated: boolean } {
  configured(prefix);
  if (schemas().validate("#", input).length > 0)
    throw fail("INPUT_INVALID", "Invalid issue list input");
  const { limit = 1000, label = [], labels = [], ...by } = input as Input;
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
  const value = (at: number) => records[at]!.value as Stored;
  const statusOf = new Map(ids.map((id, at) => [id, value(at).status]));
  const parent =
    by.parent === undefined || by.parent === "none"
      ? undefined
      : storedId(by.parent, prefix, (given) =>
          records.some((_, at) => (value(at).prefix ?? "work") === given),
        );
  const since = by.createdSince === undefined ? 0 : Date.parse(by.createdSince);
  const leases = new Map<number, ReturnType<typeof leaseOf>>();
  const lease = (at: number) => {
    if (!leases.has(at)) leases.set(at, leaseOf(views, ids[at]!));
    return leases.get(at);
  };
  const wanted = [...labels, ...label];
  const picked = records.flatMap((_, at) => {
    const v = value(at);
    const ok =
      (by.parent === undefined || v.parent === parent) &&
      (by.kind === undefined || v.kind === by.kind) &&
      wanted.every((name) => v.labels.includes(name)) &&
      (by.status === undefined || v.status === by.status) &&
      (by.createdSince === undefined || Date.parse(v.createdAt) >= since) &&
      (by.ready !== true ||
        (v.status === "open" &&
          v.dependsOn.every((dep) => statusOf.get(dep) === "closed") &&
          !holdsLease(lease(at), now)));
    return ok ? [at] : [];
  });
  return {
    items: picked
      .slice(0, limit)
      .map((at) => shownItem(records[at]!, ids[at]!, lease(at), now, prefix)),
    truncated: picked.length > limit,
  };
}
