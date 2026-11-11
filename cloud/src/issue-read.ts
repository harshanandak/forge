// Reads one work issue from the state tables and writes nothing: read-only views, only the fixed
// SELECTs below, every stored value untrusted (bytes bounded before a body is loaded, identity
// checked against the key the server derived). Caller text only becomes a bound SQL value, and
// only after it matches `<prefix>-<digits>`.
import manifest from "../../src/blocks/work/forge.block.json" with { type: "json" };
import config from "../../src/blocks/work/schemas/config.json" with { type: "json" };
import ItemRef from "../../src/blocks/work/schemas/ItemRef.json" with { type: "json" };
import TrackerItemSchema from "../../src/blocks/work/schemas/TrackerItem.json" with { type: "json" };
import { ForgeFailure } from "../../src/contract/failure.ts";
import {
  SchemaRegistry,
  validateWithSchema,
} from "../../src/contract/schema.ts";
import { parseUntrustedJson } from "../../src/contract/untrusted.ts";
import { SCHEMA_DOCUMENTS } from "../../src/generated/schemas.ts";
import type { TrackerItem } from "../../src/generated/types.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
const NAMESPACE = "forge/work";
export const MAX_RECORD_BYTES = 2 * 1024 * 1024; // bytes; above the 1 MiB response bound so that bound can be reached
export const MAX_LEASE_BYTES = 16 * 1024;
export const MAX_DEPTH = 8;
export const MAX_NODES = 1024;
const QUALIFIED = /^([a-z0-9]+(?:-[a-z0-9]+)*)-(\d+)$/i;
const BODY = (table: string, column: string) =>
  `SELECT CASE WHEN length(CAST(body AS BLOB)) <= ? THEN body END AS body FROM ${table} WHERE namespace=? AND ${column}=?`;
const RECORD = BODY("state_records", "key");
const LEASE = BODY("state_leases", "subject");
// MODE: a slots record (competing) or any participant record (collaborative) exists.
// MINTED: a stored issue carries this prefix (`work` if none): in-bound, valid JSON, wrapper and value id matching its row.
const MODE =
  "SELECT 1 AS found FROM state_records WHERE namespace=? AND (key=? OR (key>=? AND key<?)) LIMIT 1";
const MINTED =
  "SELECT 1 AS found FROM state_records WHERE namespace=? AND key>=? AND key<? AND CASE WHEN length(CAST(body AS BLOB)) <= ? THEN CASE WHEN json_valid(body) THEN CASE WHEN json_type(body,'$.value')='object' AND json_extract(body,'$.namespace')=namespace AND json_extract(body,'$.key')=key AND json_extract(body,'$.value.id')=substr(key,7) THEN coalesce(json_extract(body,'$.value.prefix'),'work') END END END=? LIMIT 1";

/** The only statements each read-only view may run; a view refuses any other text. */
export const RECORD_READS = [MODE, MINTED, RECORD] as const;
export const LEASE_READS = [LEASE] as const;

/** Read-only views of the two state tables; undefined when the table does not exist yet. */
export interface IssueViews {
  readonly records: SqlDatabase | undefined;
  readonly leases: SqlDatabase | undefined;
}
type Json = Record<string, unknown>;
if (manifest.operations["issue.show"].input !== "schemas/ItemRef.json")
  throw new Error("issue.show no longer declares schemas/ItemRef.json");
if (manifest.operations["issue.show"].output !== "schemas/TrackerItem.json")
  throw new Error("issue.show no longer declares schemas/TrackerItem.json");
let registry: SchemaRegistry | undefined;
const fail = (code: string, message: string): ForgeFailure =>
  new ForgeFailure({ code, message, retry: "never" });
const invalid = () => fail("INTERNAL", "Stored issue is not valid");
const object = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One stored JSON object, or undefined when there is no row. A body over `max` bytes comes back NULL, unread. */
function load(
  db: SqlDatabase | undefined,
  sql: string,
  max: number,
  key: string,
): Json | undefined {
  const row = db?.get(sql, [max, NAMESPACE, key]);
  if (row === undefined) return undefined;
  const parsed =
    typeof row.body === "string"
      ? parseUntrustedJson(row.body, {
          maxBytes: max,
          maxDepth: MAX_DEPTH,
          maxNodes: MAX_NODES,
          maxStringLength: max,
        })
      : undefined;
  if (!parsed?.ok || !object(parsed.value)) throw invalid();
  return parsed.value;
}

/**
 * The issue `input` names, shaped as the local issue.show shows it: stored prefix and close reason
 * dropped, ids carrying `prefix`. A lease appears only while live at `now`, and only from state_leases.
 */
export function readIssue(
  views: IssueViews,
  input: unknown,
  now: number,
  prefix: string,
): TrackerItem {
  // The server's own setting is checked first, with the work block's idPrefix rule, before any input.
  if (validateWithSchema(config.properties.idPrefix, prefix).length > 0)
    throw fail("UNAVAILABLE", "Server configuration is not valid");
  registry ??= new SchemaRegistry(SCHEMA_DOCUMENTS);
  if (registry.validate(ItemRef.$ref, input).length > 0)
    throw fail("INPUT_INVALID", "input must be { id } with a valid issue id");
  const match = QUALIFIED.exec((input as { id: string }).id);
  if (match === null) throw fail("INPUT_INVALID", "Invalid issue id");
  const given = match[1]!.toLowerCase();
  const minted = [NAMESPACE, "issue:", "issue;", MAX_RECORD_BYTES, given];
  if (given !== prefix && views.records?.get(MINTED, minted) === undefined)
    throw fail("INPUT_INVALID", "Unknown issue id prefix");
  const id = `work-${match[2]}`;
  const record = load(views.records, RECORD, MAX_RECORD_BYTES, `issue:${id}`);
  if (record === undefined) throw fail("NOT_FOUND", "Issue was not found");
  if (
    views.records?.get(MODE, [
      NAMESPACE,
      `slots:${id}`,
      `participant:${id}:`,
      `participant:${id};`,
    ]) !== undefined
  )
    throw fail(
      "INPUT_INVALID",
      "Competing and collaborative issues are not yet supported in cloud",
    );
  const { value } = record;
  if (
    record.namespace !== NAMESPACE ||
    record.key !== `issue:${id}` ||
    !object(value) ||
    value.id !== id ||
    !Array.isArray(value.dependsOn) ||
    !value.dependsOn.every((dep) => typeof dep === "string") ||
    !["string", "undefined"].includes(typeof value.parent)
  )
    throw invalid();
  const lease = load(views.leases, LEASE, MAX_LEASE_BYTES, `issue:${id}`);
  if (lease !== undefined && lease.subject !== `issue:${id}`) throw invalid();
  const shown = (stored: string): string =>
    /^work-\d+$/.test(stored) ? `${prefix}-${stored.slice(5)}` : stored;
  const {
    closeReason: _reason,
    prefix: _minted,
    lease: _forged,
    ...rest
  } = value;
  const live =
    lease !== undefined &&
    lease.releasedAt === undefined &&
    typeof lease.expiresAt === "string" &&
    Date.parse(lease.expiresAt) > now;
  const item = {
    ...rest,
    id: shown(id),
    dependsOn: value.dependsOn.map(shown),
    ...(value.parent === undefined
      ? {}
      : { parent: shown(value.parent as string) }),
    updatedAt: record.updatedAt,
    revision: record.revision,
    ...(live ? { lease } : {}),
  };
  // Everything projected above, including the wrapper's revision and updatedAt and the live lease.
  if (registry.validate(TrackerItemSchema.$ref, item).length > 0)
    throw invalid();
  return item as unknown as TrackerItem;
}
