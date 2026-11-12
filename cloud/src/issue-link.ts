// issue.link at the project authority, for a caller that holds the issue's live lease. It follows the local
// handler: the input is checked against the declared schema, the id resolves to a stored issue that must
// exist, then the URL pattern is applied, as the local handler does and with no other URL policy. The link
// is numbered from the count of the issue's links and written once (expected revision 0) through the
// state owner, fenced on the issue's lease. The check refusals are recorded; the fence, revision and
// readback refusals run in the transaction that also writes the event and the receipt, so they roll
// back and are not recorded. The answer is the whole stored record, and a replay checks the lease again.
import manifest from "../../src/blocks/work/forge.block.json" with { type: "json" };
import LinkInput from "../../src/blocks/work/schemas/link.json" with { type: "json" };
import LinkOutput from "../../src/blocks/work/schemas/record.json" with { type: "json" };
import { validateWithSchema } from "../../src/contract/schema.ts";
import { canonicalJson } from "../../src/core/config/pointer.ts";
import type { StateOwner } from "../../src/core/state/index.ts";
import type { StateRecord } from "../../src/generated/types.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import { fail, minted, schemas, storedId } from "./issue-read.ts";
import { fence, heldLease } from "./issue-update.ts";
import { receipted, type WriteCall } from "./issue-write.ts";

const NAMESPACE = "forge/work";
const link = manifest.operations["issue.link"];
if (link.input !== "schemas/link.json" || link.output !== "schemas/record.json")
  throw new Error("issue.link no longer declares its input and output");
interface Fields {
  id: string;
  relation: string;
  url: string;
}
// The local handler's pattern, character for character: no trimming, parsing or host policy.
const URL_PATTERN = /^https?:\/\/[^\s/]+(?:\/[^\s]*)?$/;

/** Appends one link to an existing issue, or returns the recorded record while the caller still holds its lease. */
export function linkIssue(
  db: SqlDatabase,
  owner: StateOwner,
  call: WriteCall,
): StateRecord {
  return receipted(
    db,
    owner,
    "issue.link",
    call,
    (input, prefix): Fields => {
      if (validateWithSchema(LinkInput, input).length > 0)
        throw fail(
          "INPUT_INVALID",
          "input must be { id, relation, url } with a valid issue id, relation and URL",
        );
      const fields = input as Fields;
      const id = storedId(fields.id, prefix, minted(db));
      // The local order: an absent issue is named, as the caller wrote it, before the URL is read.
      if (owner.get(NAMESPACE, `issue:${id}`) === undefined)
        throw fail("NOT_FOUND", `Issue ${fields.id} was not found`);
      if (!URL_PATTERN.test(fields.url))
        throw fail("INPUT_INVALID", "Links require an http or https URL");
      return { ...fields, id };
    },
    (fields, actor, _prefix, context) => {
      const held = fence(context, fields.id, "issue.link");
      const base = `link:${fields.id}:`;
      const key = `${base}${owner.count(NAMESPACE, base) + 1}`;
      const written = owner.put(NAMESPACE, key, fields, actor, {
        expectRevision: 0,
        fence: held,
      });
      if (canonicalJson(owner.get(NAMESPACE, key)) !== canonicalJson(written))
        throw fail(
          "INTERNAL",
          "Accepted write did not match its readback; reconcile before retrying",
        );
      if (schemas().validate(LinkOutput.$ref, written).length > 0)
        throw fail("INTERNAL", "Link result is not valid");
      return written;
    },
    // The recorded record names its issue in its stored value, checked against the input schema and the URL pattern first.
    (prior, context) => {
      if (
        validateWithSchema(LinkInput, prior.value).length > 0 ||
        !URL_PATTERN.test((prior.value as Fields).url)
      )
        throw fail("INTERNAL", "Stored link is not valid");
      heldLease(owner, context, (prior.value as Fields).id, "issue.link");
    },
  );
}
