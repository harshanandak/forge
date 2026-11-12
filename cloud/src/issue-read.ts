// Reads one work issue from the state tables and writes nothing: read-only views, only the fixed
// SELECTs below, every stored value untrusted (bytes bounded before a body is loaded, identity
// checked against the key the server derived). Caller text only becomes a bound SQL value, and
// only after it matches `<prefix>-<digits>`.
import manifest from "../../src/blocks/work/forge.block.json" with { type: "json" };
import config from "../../src/blocks/work/schemas/config.json" with { type: "json" };
import ItemRef from "../../src/blocks/work/schemas/ItemRef.json" with { type: "json" };
import ListItemsInput from "../../src/blocks/work/schemas/ListItemsInput.json" with { type: "json" };
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
/** The most a read response may be, in UTF-8 bytes, measured on the whole envelope. */
export const MAX_SHOW_RESPONSE_BYTES = 1_048_576;
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

// SCAN: the key and byte size of every issue row, in key order, before any body is loaded.
// ROWS: the same rows with their bodies. Both end with a bound row limit.
const ISSUES =
  "FROM state_records WHERE namespace=? AND key>=? AND key<? ORDER BY key LIMIT ?";
export const SCAN = `SELECT key, length(CAST(body AS BLOB)) AS size ${ISSUES}`;
export const ROWS = `SELECT key, body ${ISSUES}`;

// List only. COMPACT: each issue row with a text value.body of at most 65,536 characters blanked, the
// stored text otherwise. A body of another type, a longer one or a duplicate field stays whole, so the
// parse and schema checks decide it as they do for a full record. A body is blanked when its bytes are
// at most 65,536 (never more characters than bytes), or when it holds no NUL byte and its SQL character
// count is at most 65,536 (SQL counts characters only up to a NUL, so a NUL body is judged by bytes).
// A row over the record cap or that is not JSON returns a NULL body, which the parse refuses. PREFLIGHT
// counts those rows and their payload (key, size and body bytes) without returning any of them.
const BODY_OF = "CAST(json_extract(body,'$.value.body') AS BLOB)";
const BLANKED = `CASE WHEN length(CAST(body AS BLOB)) <= ? AND json_valid(body) THEN CASE WHEN json_type(body,'$.value.body')='text' AND (length(${BODY_OF}) <= 65536 OR (instr(${BODY_OF}, x'00') = 0 AND length(json_extract(body,'$.value.body')) <= 65536)) THEN json_set(body,'$.value.body','') ELSE body END END`;
export const COMPACT = `SELECT key, length(CAST(body AS BLOB)) AS size, ${BLANKED} AS body ${ISSUES}`;
export const PREFLIGHT = `SELECT count(*) AS count, coalesce(sum(length(CAST(key AS BLOB)) + length(CAST(size AS BLOB)) + coalesce(length(CAST(body AS BLOB)), 0)), 0) AS bytes FROM (${COMPACT})`;

/** The only statements each read-only view may run; a view refuses any other text. */
export const RECORD_READS = [
  MODE,
  MINTED,
  RECORD,
  SCAN,
  ROWS,
  COMPACT,
  PREFLIGHT,
] as const;
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
/** The declared schemas, built once: the shared documents and the list input. */
export const schemas = (): SchemaRegistry =>
  (registry ??= new SchemaRegistry([...SCHEMA_DOCUMENTS, ListItemsInput]));
export const fail = (code: string, message: string): ForgeFailure =>
  new ForgeFailure({ code, message, retry: "never" });
export const invalid = () => fail("INTERNAL", "Stored issue is not valid");
const object = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The server's own prefix setting, checked with the work block's idPrefix rule before any input. */
export function configured(prefix: unknown): void {
  if (validateWithSchema(config.properties.idPrefix, prefix).length > 0)
    throw fail("UNAVAILABLE", "Server configuration is not valid");
}

/** One stored JSON object, or undefined when there is no row. A body over `max` bytes comes back NULL, unread. */
function load(
  db: SqlDatabase | undefined,
  sql: string,
  max: number,
  key: string,
): Json | undefined {
  const row = db?.get(sql, [max, NAMESPACE, key]);
  return row === undefined ? undefined : parseBody(row.body, max);
}

/** The stored `issue:<id>` record, or undefined when there is none: no mode check, lease or projection. */
export const issueRecord = (views: IssueViews, id: string): Json | undefined =>
  load(views.records, RECORD, MAX_RECORD_BYTES, `issue:${id}`);

/** One stored JSON object: a body that is not text, not JSON, too deep or not an object is invalid. */
export function parseBody(body: unknown, max: number): Json {
  const parsed =
    typeof body === "string"
      ? parseUntrustedJson(body, {
          maxBytes: max,
          maxDepth: MAX_DEPTH,
          maxNodes: MAX_NODES,
          maxStringLength: max,
        })
      : undefined;
  if (!parsed?.ok || !object(parsed.value)) throw invalid();
  return parsed.value;
}

/** The stored id for a caller's `<prefix>-<digits>`, once its prefix is current or `minted` here. */
export function storedId(
  id: string,
  prefix: string,
  minted: (given: string) => boolean,
): string {
  const match = QUALIFIED.exec(id);
  if (match === null) throw fail("INPUT_INVALID", "Invalid issue id");
  const given = match[1]!.toLowerCase();
  if (given !== prefix && !minted(given))
    throw fail("INPUT_INVALID", "Unknown issue id prefix");
  return `work-${match[2]}`;
}

/** Whether a stored issue in `db` carries the id prefix `given`: the historical prefixes an id may name. */
export const minted =
  (db: SqlDatabase | undefined) =>
  (given: string): boolean =>
    db?.get(MINTED, [
      NAMESPACE,
      "issue:",
      "issue;",
      MAX_RECORD_BYTES,
      given,
    ]) !== undefined;

/** The shown id for a stored `work-<digits>`: the current prefix in place of `work`. Any other id is kept. */
export const shownId = (stored: string, prefix: string): string =>
  /^work-\d+$/.test(stored) ? `${prefix}-${stored.slice(5)}` : stored;

/** A lease that holds its issue at `now`: not released and not yet expired. */
export const holds = (lease: Json | undefined, now: number): boolean =>
  lease !== undefined &&
  lease.releasedAt === undefined &&
  typeof lease.expiresAt === "string" &&
  Date.parse(lease.expiresAt) > now;

const LEASE_RECORD =
  "https://raw.githubusercontent.com/harshanandak/forge/main/schemas/state.json#/$defs/LeaseRecord";

/** Whether `lease` holds the issue at `now`. A stored lease is checked as a whole first, live or not, else INTERNAL. */
export function holdsLease(lease: Json | undefined, now: number): boolean {
  if (lease !== undefined && schemas().validate(LEASE_RECORD, lease).length > 0)
    throw invalid();
  return holds(lease, now);
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
  configured(prefix);
  if (schemas().validate(ItemRef.$ref, input).length > 0)
    throw fail("INPUT_INVALID", "input must be { id } with a valid issue id");
  const id = storedId(
    (input as { id: string }).id,
    prefix,
    minted(views.records),
  );
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
  checkedValue(record, id);
  return shownItem(record, id, leaseOf(views, id), now, prefix);
}

type Checked = Json & { dependsOn: string[] };
/** The stored value, once its wrapper and value agree with `id`. No lease is read here. */
export function checkedValue(record: Json, id: string): Checked {
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
  return value as Checked;
}

/** The stored lease for `id`, if any, once its subject agrees. Reads state_leases. */
export function leaseOf(views: IssueViews, id: string): Json | undefined {
  const lease = load(views.leases, LEASE, MAX_LEASE_BYTES, `issue:${id}`);
  if (lease !== undefined && lease.subject !== `issue:${id}`) throw invalid();
  return lease;
}

/** One stored issue as the local show and list return it, once its wrapper and value agree with `id`; `lease` is shown only while live. */
export function shownItem(
  record: Json,
  id: string,
  lease: Json | undefined,
  now: number,
  prefix: string,
): TrackerItem {
  const value = checkedValue(record, id);
  const shown = (stored: string): string => shownId(stored, prefix);
  const {
    closeReason: _reason,
    prefix: _minted,
    lease: _forged,
    ...rest
  } = value;
  const item = {
    ...rest,
    id: shown(id),
    dependsOn: value.dependsOn.map(shown),
    ...(value.parent === undefined
      ? {}
      : { parent: shown(value.parent as string) }),
    updatedAt: record.updatedAt,
    revision: record.revision,
    ...(holds(lease, now) ? { lease } : {}),
  };
  // Everything projected above, including the wrapper's revision and updatedAt and the live lease.
  if (schemas().validate(TrackerItemSchema.$ref, item).length > 0)
    throw invalid();
  return item as unknown as TrackerItem;
}
