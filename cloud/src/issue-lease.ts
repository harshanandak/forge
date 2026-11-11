// issue.renew and issue.release at the project authority. Stubs until the tests that pin them have run red.
import type { StateOwner } from "../../src/core/state/index.ts";
import type { LeaseGrant } from "../../src/generated/types.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import { fail } from "./issue-read.ts";
import type { WriteCall } from "./issue-write.ts";

export function renewIssue(
  _db: SqlDatabase,
  _owner: StateOwner,
  _call: WriteCall,
): LeaseGrant {
  throw fail("INTERNAL", "issue.renew is not implemented");
}

export function releaseIssue(
  _db: SqlDatabase,
  _owner: StateOwner,
  _call: WriteCall,
): { id: string } {
  throw fail("INTERNAL", "issue.release is not implemented");
}
