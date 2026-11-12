// issue.close at the project authority, for a caller that holds the issue's live lease, with an explicit
// withoutReceipt reason only: a receipt needs the cloud to verify a receipt and a merged pull request, so it
// is refused by name before any lookup. The checks run in the local handler's order: the issue must exist
// (recorded as a refusal), then in the transaction a competing issue with no selection is refused after the
// lease is checked (an empty write fenced on the lease), then a missing reason, then the fenced write.
// Those refusals roll back and are not recorded. The lease stays held after the close, as locally.
import manifest from "../../src/blocks/work/forge.block.json" with { type: "json" };
import CloseInput from "../../src/blocks/work/schemas/CloseInput.json" with { type: "json" };
import { ForgeFailure } from "../../src/contract/failure.ts";
import type { StateOwner } from "../../src/core/state/index.ts";
import type { TrackerItem } from "../../src/generated/types.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import {
  checkedValue,
  fail,
  minted,
  schemas,
  shownId,
  storedId,
} from "./issue-read.ts";
import { fence, heldReplay, shownWrite } from "./issue-update.ts";
import { receipted, type WriteCall } from "./issue-write.ts";

const NAMESPACE = "forge/work";
const close = manifest.operations["issue.close"];
if (
  close.input !== "schemas/CloseInput.json" ||
  close.output !== "schemas/TrackerItem.json"
)
  throw new Error("issue.close no longer declares its input and output");
interface Fields {
  id: string;
  reason?: string | undefined;
  withoutReceipt?: string | undefined;
}

/** Closes one issue with a withoutReceipt reason, or returns the recorded answer while the caller still holds its lease. */
export function closeIssue(
  db: SqlDatabase,
  owner: StateOwner,
  call: WriteCall,
): TrackerItem {
  return receipted(
    db,
    owner,
    "issue.close",
    call,
    (input, prefix): Fields => {
      // Refused by name, never dropped: receipt-backed close is not served yet.
      if (typeof input === "object" && input !== null && "receipt" in input)
        throw fail(
          "INPUT_INVALID",
          "issue.close with a receipt is not supported in cloud yet",
        );
      if (schemas().validate(CloseInput.$ref, input).length > 0)
        throw fail(
          "INPUT_INVALID",
          "input must be { id, reason?, withoutReceipt? } with a valid issue id",
        );
      const { id: given, ...rest } = input as Fields;
      const id = storedId(given, prefix, minted(db));
      if (owner.get(NAMESPACE, `issue:${id}`) === undefined)
        throw fail("NOT_FOUND", `Issue ${given} was not found`);
      return { id, ...rest };
    },
    ({ id, reason, withoutReceipt }, actor, prefix, context) => {
      const held = fence(context, id, "issue.close");
      const record = owner.get(NAMESPACE, held.subject)!;
      const {
        receipt: _receipt,
        withoutReceipt: _exemption,
        ...previous
      } = checkedValue({ ...record }, id);
      // The local read set: the competition rows, so the event records the same basis.
      const reads = ["slots", "selection"].map((name) => ({
        key: `${name}:${id}`,
        expectRevision: owner.get(NAMESPACE, `${name}:${id}`)?.revision ?? 0,
      }));
      if (reads[0]!.expectRevision > 0 && reads[1]!.expectRevision === 0) {
        // Only the lease holder learns the issue is competing: any other caller gets the lease refusal.
        owner.putMany(NAMESPACE, [], actor, { fence: held });
        const shown = shownId(id, prefix);
        throw new ForgeFailure({
          code: "INPUT_CONFLICT",
          message: "Select an attempt before closing a competing issue",
          retry: "never",
          repair: `forge attempt select ${shown} --attempt <attempt-id> --reason "<why>"; or forge attempt select ${shown} --none --reason "<why>"`,
        });
      }
      if (withoutReceipt === undefined)
        throw fail(
          "RECEIPT_REQUIRED",
          "Supply a PASS receipt or an explicit withoutReceipt reason",
        );
      const written = owner.put(
        NAMESPACE,
        held.subject,
        {
          ...previous,
          status: "closed",
          withoutReceipt,
          ...(reason === undefined ? {} : { closeReason: reason }),
        },
        actor,
        { expectRevision: record.revision, fence: held, readSet: reads },
      );
      return shownWrite(owner, written, id, prefix);
    },
    heldReplay(owner, "issue.close"),
  );
}
