// issue.close at the project authority: a stub, so the tests land first and run red. The command is not
// wired into the route yet.
import type { StateOwner } from "../../src/core/state/index.ts";
import type { TrackerItem } from "../../src/generated/types.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import type { WriteCall } from "./issue-write.ts";

/** Closes one issue without a receipt, or returns the recorded answer while the caller still holds its lease. */
export function closeIssue(
  _db: SqlDatabase,
  _owner: StateOwner,
  _call: WriteCall,
): TrackerItem {
  throw new Error("issue.close is not implemented");
}
