// issue.dep at the project authority, for a caller that holds the issue's live lease. It adds or removes
// one dependency with the local handler's rules, in its order: the issue must exist, the new list may
// hold at most 256, and the graph it makes may not hold a cycle or a missing issue (so a removal can
// repair a dangling dependency). Existence is checked with the input and recorded as a refusal; the cap,
// graph and fence checks run in the transaction that also writes the event and the receipt, so their
// refusals roll back and are not recorded. The graph walk is iterative and reads at most MAX_SCAN_ROWS
// issues, a limit the local handler does not have.
import manifest from "../../src/blocks/work/forge.block.json" with { type: "json" };
import DepInput from "../../src/blocks/work/schemas/dep.json" with { type: "json" };
import { validateWithSchema } from "../../src/contract/schema.ts";
import type { StateOwner } from "../../src/core/state/index.ts";
import type { TrackerItem } from "../../src/generated/types.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import { MAX_SCAN_ROWS } from "./issue-list.ts";
import { checkedValue, fail, minted, shownId, storedId } from "./issue-read.ts";
import { fence, heldReplay, shownWrite } from "./issue-update.ts";
import { receipted, type WriteCall } from "./issue-write.ts";

const NAMESPACE = "forge/work";
const MAX_DEPENDENCIES = 256;
const dep = manifest.operations["issue.dep"];
if (
  dep.input !== "schemas/dep.json" ||
  dep.output !== "schemas/TrackerItem.json"
)
  throw new Error("issue.dep no longer declares its input and output");
interface Fields {
  id: string;
  target: string;
  action: "add" | "remove";
  expectRevision: number;
}

// Walks the dependencies `id` would have, depth first and in order, as the local graph check does: a cycle
// or a missing issue refuses the change, and a missing one is named before a cycle. Each issue is read once.
function checkGraph(
  owner: StateOwner,
  id: string,
  dependencies: readonly string[],
  prefix: string,
): void {
  const seen = new Map<string, "active" | "done">([[id, "active"]]);
  const stack = [{ id, dependencies, index: 0 }];
  let cycle = false;
  let missing: string | undefined;
  let reads = 0;
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.index === frame.dependencies.length) {
      seen.set(frame.id, "done");
      stack.pop();
      continue;
    }
    const next = frame.dependencies[frame.index++]!;
    const state = seen.get(next);
    if (state === "active") cycle = true;
    if (state !== undefined) continue;
    if (++reads > MAX_SCAN_ROWS)
      throw fail("UNAVAILABLE", "Dependency graph is over its read budget");
    const record = owner.get(NAMESPACE, `issue:${next}`);
    if (record === undefined) {
      missing ??= next;
      seen.set(next, "done");
      continue;
    }
    seen.set(next, "active");
    stack.push({
      id: next,
      dependencies: checkedValue({ ...record }, next).dependsOn,
      index: 0,
    });
  }
  if (missing !== undefined)
    throw fail("NOT_FOUND", `Issue ${shownId(missing, prefix)} was not found`);
  if (cycle)
    throw fail("INPUT_CONFLICT", "Dependencies must not contain a cycle");
}

/** Adds or removes one dependency of one issue, or returns the recorded answer while the caller still holds its lease. */
export function depIssue(
  db: SqlDatabase,
  owner: StateOwner,
  call: WriteCall,
): TrackerItem {
  return receipted(
    db,
    owner,
    "issue.dep",
    call,
    (input, prefix): Fields => {
      if (validateWithSchema(DepInput, input).length > 0)
        throw fail(
          "INPUT_INVALID",
          "input must be { id, target, action, expectRevision } with valid issue ids",
        );
      const { id: given, target, ...rest } = input as Fields;
      const mint = minted(db);
      const id = storedId(given, prefix, mint);
      // The local order: an absent issue is named, as the caller wrote it, before the target is read.
      if (owner.get(NAMESPACE, `issue:${id}`) === undefined)
        throw fail("NOT_FOUND", `Issue ${given} was not found`);
      return { id, target: storedId(target, prefix, mint), ...rest };
    },
    ({ id, target, action, expectRevision }, actor, prefix, context) => {
      const held = fence(context, id, "issue.dep");
      const current = checkedValue(
        { ...owner.get(NAMESPACE, held.subject)! },
        id,
      );
      const dependsOn =
        action === "add"
          ? [...new Set([...current.dependsOn, target])]
          : current.dependsOn.filter((dependency) => dependency !== target);
      if (dependsOn.length > MAX_DEPENDENCIES)
        throw fail("INPUT_INVALID", "At most 256 dependencies are allowed");
      checkGraph(owner, id, dependsOn, prefix);
      const written = owner.put(
        NAMESPACE,
        held.subject,
        { ...current, dependsOn },
        actor,
        { expectRevision, fence: held },
      );
      return shownWrite(owner, written, id, prefix);
    },
    heldReplay(owner, "issue.dep"),
  );
}
