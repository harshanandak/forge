// issue.dep at the project authority, for a caller that holds the issue's live lease. The tests land
// first against this stub, so CI shows them red for the right reason before the implementation arrives.
import type { StateOwner } from "../../src/core/state/index.ts";
import type { TrackerItem } from "../../src/generated/types.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import { fail } from "./issue-read.ts";
import type { WriteCall } from "./issue-write.ts";

/** Adds or removes one dependency of one issue, or returns the recorded answer while the caller still holds its lease. */
export function depIssue(
  _db: SqlDatabase,
  _owner: StateOwner,
  _call: WriteCall,
): TrackerItem {
  throw fail("INTERNAL", "issue.dep is not implemented");
}
