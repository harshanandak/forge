// Reads one work issue from the project authority's state tables without writing anything.
// Placeholder: the real read layer lands with the commit that follows the tests.
import type { SqlDatabase } from "../../src/ports/store.ts";
import type { TrackerItem } from "../../src/generated/types.ts";

/** Stored issue record bound in bytes; above the response bound so that bound can be reached. */
export const MAX_RECORD_BYTES = 2 * 1024 * 1024;
export const MAX_LEASE_BYTES = 16 * 1024;
export const MAX_DEPTH = 8;
export const MAX_NODES = 1024;

/** Read-only views of the two state tables; undefined when the table does not exist yet. */
export interface IssueViews {
  readonly records: SqlDatabase | undefined;
  readonly leases: SqlDatabase | undefined;
}

export function readIssue(
  _views: IssueViews,
  _input: unknown,
  _now: number,
  _prefix: string,
): TrackerItem {
  throw new Error("readIssue is not implemented");
}
