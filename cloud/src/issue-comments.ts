// Reads one issue's comments and writes nothing. Same read-only views and fixed statements as show and
// list, and no lease. The issue must exist; its comments are scanned for key and size before any body
// is loaded, so an issue over the row budget, or over the response cap in stored bytes (a reply over it
// is refused anyway), is refused, never read partly. Every stored
// record is untrusted and checked whole: any bad row refuses the read. Parity with the local read
// holds within these cloud limits: full records, in append-number order, with no pagination.
import manifest from "../../src/blocks/work/forge.block.json" with { type: "json" };
import ItemRef from "../../src/blocks/work/schemas/ItemRef.json" with { type: "json" };
import Records from "../../src/blocks/work/schemas/records.json" with { type: "json" };
import { SchemaRegistry } from "../../src/contract/schema.ts";
import { SCHEMA_DOCUMENTS } from "../../src/generated/schemas.ts";
import {
  configured,
  fail,
  invalid,
  issueRecord,
  MAX_RECORD_BYTES,
  MAX_SHOW_RESPONSE_BYTES,
  minted,
  parseBody,
  ROWS,
  SCAN,
  schemas,
  storedId,
  type IssueViews,
} from "./issue-read.ts";
import { MAX_SCAN_ROWS } from "./issue-list.ts";

const NAMESPACE = "forge/work";
const comments = manifest.operations["issue.comments"];
if (
  comments.input !== "schemas/ItemRef.json" ||
  comments.output !== "schemas/records.json"
)
  throw new Error("issue.comments no longer declares its input and output");

// records.json is its own inline root, so it gets its own registry beside the one with the list input.
let output: SchemaRegistry | undefined;
const outputs = (): SchemaRegistry =>
  (output ??= new SchemaRegistry([...SCHEMA_DOCUMENTS, Records]));

/** The issue's comment records in append order: the key order first, then a stable sort on the number each key ends with. */
export function listComments(
  views: IssueViews,
  input: unknown,
  _now: number,
  prefix: string,
): { records: object[] } {
  configured(prefix);
  if (schemas().validate(ItemRef.$ref, input).length > 0)
    throw fail("INPUT_INVALID", "input must be { id } with a valid issue id");
  const given = (input as { id: string }).id;
  const id = storedId(given, prefix, minted(views.records));
  if (issueRecord(views, id) === undefined)
    throw fail("NOT_FOUND", `Issue ${given} was not found`);
  const start = `comment:${id}:`;
  const range = [NAMESPACE, start, `comment:${id};`, MAX_SCAN_ROWS + 1];
  const sizes = views.records?.all(SCAN, range) ?? [];
  if (sizes.some((row) => Number(row.size) > MAX_RECORD_BYTES)) throw invalid();
  if (
    sizes.length > MAX_SCAN_ROWS ||
    sizes.reduce((sum, row) => sum + Number(row.size), 0) >
      MAX_SHOW_RESPONSE_BYTES
  )
    throw fail("UNAVAILABLE", "Issue comments are over their read budget");
  const rows = views.records?.all(ROWS, range) ?? [];
  if (rows.length !== sizes.length) throw invalid();
  const records = rows.map((row) => {
    const record = parseBody(row.body, MAX_RECORD_BYTES);
    if (record.namespace !== NAMESPACE || record.key !== row.key)
      throw invalid();
    return record;
  });
  const number = (record: { key?: unknown }) =>
    Number(String(record.key).slice(start.length));
  const result = {
    records: records.toSorted((a, b) => number(a) - number(b)),
  };
  if (outputs().validate("#", result).length > 0) throw invalid();
  return result;
}
