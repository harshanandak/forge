// issue.update at the project authority: a stub until the write is built.
import type { StateOwner } from "../../src/core/state/index.ts";
import type { TrackerItem } from "../../src/generated/types.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import { fail } from "./issue-read.ts";
import type { WriteCall } from "./issue-write.ts";

/** Not served yet. */
export function updateIssue(
  _db: SqlDatabase,
  _owner: StateOwner,
  _call: WriteCall,
): TrackerItem {
  throw fail("INPUT_INVALID", "Commands are not yet supported in cloud");
}
