// issue.claim at the project authority. This is a stub: the implementation lands in the next commit.
import type { StateOwner } from "../../src/core/state/index.ts";
import type { LeaseGrant } from "../../src/generated/types.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import { fail } from "./issue-read.ts";
import type { WriteCall } from "./issue-write.ts";

/** Takes the lease on one issue after the issue checks, or returns the recorded grant while it is still current. */
export function claimIssue(
  _db: SqlDatabase,
  _owner: StateOwner,
  _call: WriteCall,
): LeaseGrant {
  throw fail("UNAVAILABLE", "issue.claim is not implemented yet");
}
