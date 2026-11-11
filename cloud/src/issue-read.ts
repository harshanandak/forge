// Reads one work issue from the project authority's state tables and writes nothing. It takes
// read-only views, runs only the fixed SELECTs below, and treats every stored value as untrusted:
// bytes are bounded before a body is loaded, and the record's identity must match the key the
// server derived. Caller text only ever becomes a bound
// SQL value, and only after it has been matched to `<prefix>-<digits>`.
import manifest from "../../src/blocks/work/forge.block.json" with { type: "json" };
import ItemRef from "../../src/blocks/work/schemas/ItemRef.json" with { type: "json" };
import { ForgeFailure } from "../../src/contract/failure.ts";
import { SchemaRegistry } from "../../src/contract/schema.ts";
import {
  DEFAULT_PARSE_LIMITS,
  parseUntrustedJson,
} from "../../src/contract/untrusted.ts";
import { SCHEMA_DOCUMENTS } from "../../src/generated/schemas.ts";
import type { TrackerItem } from "../../src/generated/types.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";

const NAMESPACE = "forge/work";
/** Stored issue record bound in bytes; above the response bound so that bound can be reached. */
export const MAX_RECORD_BYTES = 2 * 1024 * 1024;
export const MAX_LEASE_BYTES = 16 * 1024;
const QUALIFIED = /^([a-z0-9]+(?:-[a-z0-9]+)*)-(\d+)$/i;
// A body above the bound is returned as NULL and never reaches the Worker. Length is counted in bytes.
const BODY = (table: string, column: string) =>
  `SELECT CASE WHEN length(CAST(body AS BLOB)) <= ? THEN body END AS body FROM ${table} WHERE namespace=? AND ${column}=?`;
const RECORD = BODY("state_records", "key");
const LEASE = BODY("state_leases", "subject");
// Whether an issue is competing (a slots record) or collaborative (any participant record).
const MODE =
  "SELECT 1 AS found FROM state_records WHERE namespace=? AND (key=? OR (key>=? AND key<?)) LIMIT 1";
// Whether any stored issue was minted with this prefix; a record without one was minted as `work`.
const MINTED =
  "SELECT 1 AS found FROM state_records WHERE namespace=? AND key>=? AND key<? AND coalesce(CASE WHEN json_valid(body) THEN json_extract(body,'$.value.prefix') END,'work')=? LIMIT 1";

/** Read-only views of the two state tables; undefined when the table does not exist yet. */
export interface IssueViews {
  readonly records: SqlDatabase | undefined;
  readonly leases: SqlDatabase | undefined;
}
type Json = Record<string, unknown>;

if (manifest.operations["issue.show"].input !== "schemas/ItemRef.json")
  throw new Error("issue.show no longer declares schemas/ItemRef.json");
let registry: SchemaRegistry | undefined;
const fail = (code: string, message: string): ForgeFailure =>
  new ForgeFailure({ code, message, retry: "never" });
const invalid = () => fail("INTERNAL", "Stored issue is not valid");
const object = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One stored JSON object, or undefined when there is no row. Throws when it is oversize or unusable. */
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
          ...DEFAULT_PARSE_LIMITS,
          maxBytes: max,
          maxStringLength: max,
        })
      : undefined;
  if (!parsed?.ok || !object(parsed.value)) throw invalid();
  return parsed.value;
}

/**
 * The issue `input` names, as the local issue.show shows it: the stored prefix and close reason are
 * dropped, ids carry `prefix`, and revision and update time come from the record. A lease appears
 * only while it is live at `now`, and only from the lease table, never from the issue value.
 */
export function readIssue(
  views: IssueViews,
  input: unknown,
  now: number,
  prefix: string,
): TrackerItem {
  registry ??= new SchemaRegistry(SCHEMA_DOCUMENTS);
  if (registry.validate(ItemRef.$ref, input).length > 0)
    throw fail("INPUT_INVALID", "input must be { id } with a valid issue id");
  const match = QUALIFIED.exec((input as { id: string }).id);
  if (match === null) throw fail("INPUT_INVALID", "Invalid issue id");
  const given = match[1]!.toLowerCase();
  if (
    given !== prefix &&
    views.records?.get(MINTED, [NAMESPACE, "issue:", "issue;", given]) ===
      undefined
  )
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
  // The output is checked against the declared schema by the next slice, before anything uses this.
  return {
    ...rest,
    id: shown(id),
    dependsOn: value.dependsOn.map(shown),
    ...(value.parent === undefined
      ? {}
      : { parent: shown(value.parent as string) }),
    updatedAt: record.updatedAt,
    revision: record.revision,
    ...(live ? { lease } : {}),
  } as unknown as TrackerItem;
}
