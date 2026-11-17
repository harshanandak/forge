import { SCHEMA_DOCUMENTS } from "../../src/generated/schemas.ts";

export const ISSUE_INDEX = "domain_cloud_issue_index";
export const MAX_RECORD_BYTES = 2 * 1024 * 1024;

const COLUMNS = [
  "ok",
  "status",
  "kind",
  "parent",
  "labels",
  "depends_on",
  "created_at",
  "size",
];
const FIELDS = ["status", "kind", "parent", "labels", "dependsOn", "createdAt"];
type Limit = { maxItems: number; items: { maxLength: number } };
const { $defs } = SCHEMA_DOCUMENTS.find((doc) =>
  String(doc.$id).endsWith("/schemas/tracker.json"),
) as unknown as {
  $defs: {
    ItemId: { maxLength: number };
    TrackerItem: { properties: Record<"labels" | "dependsOn", Limit> };
  };
};
const { labels, dependsOn } = $defs.TrackerItem.properties;
const id = $defs.ItemId.maxLength;
const array = (count: number, chars: number) => count * (chars * 6 + 3) + 2;
const MAX_METADATA_BYTES =
  array(labels.maxItems, labels.items.maxLength) +
  array(dependsOn.maxItems, id) +
  id * 5 +
  64;
const METADATA_BYTES = FIELDS.map(
  (name) =>
    `coalesce(length(CAST(json_extract(body,'$.value.${name}') AS BLOB)),0)`,
).join(" + ");
const VALID = `CASE WHEN octet_length(body)<=${MAX_RECORD_BYTES} AND instr(CAST(body AS BLOB),x'00')=0 THEN CASE WHEN json_valid(body) THEN CASE WHEN json_type(body,'$.value')='object' AND json_extract(body,'$.namespace')=namespace AND json_extract(body,'$.key')=key AND json_extract(body,'$.value.id')=substr(key,7) AND json_type(body,'$.revision')='integer' AND json_type(body,'$.value.status')='text' AND json_type(body,'$.value.labels')='array' AND json_type(body,'$.value.dependsOn')='array' AND json_type(body,'$.value.createdAt')='text' AND coalesce(json_type(body,'$.value.parent'),'text')='text' THEN CASE WHEN ${METADATA_BYTES} > ${MAX_METADATA_BYTES} THEN 2 ELSE 1 END ELSE 0 END ELSE 0 END ELSE 0 END`;
const field = (path: string) =>
  `CASE WHEN ok=1 THEN json_extract(body,'${path}') END`;
const project = (source: string) =>
  `SELECT key, ok, ${FIELDS.map((name) => field(`$.value.${name}`)).join(", ")}, octet_length(body) FROM (SELECT key, body, ${VALID} AS ok FROM ${source} LIMIT -1) WHERE true`;
const upsert = (source: string) =>
  `INSERT INTO ${ISSUE_INDEX} ${project(source)} ON CONFLICT(key) DO UPDATE SET ${COLUMNS.map((column) => `${column}=excluded.${column}`).join(", ")}`;
const row = (side: string) =>
  `(SELECT ${side}.key AS key, ${side}.body AS body, ${side}.namespace AS namespace)`;
const scope = (side: string) =>
  `${side}.namespace='forge/work' AND substr(${side}.key,1,6)='issue:'`;

export const ISSUE_INDEX_MIGRATION = {
  id: "012_cloud_issue_index",
  statements: [
    `CREATE TABLE ${ISSUE_INDEX} (key TEXT PRIMARY KEY NOT NULL, ok INTEGER NOT NULL, status TEXT, kind, parent TEXT, labels TEXT, depends_on TEXT, created_at TEXT, size INTEGER NOT NULL) WITHOUT ROWID`,
    `INSERT INTO ${ISSUE_INDEX} ${project("state_records WHERE namespace='forge/work' AND substr(key,1,6)='issue:'")}`,
    ...["INSERT", "UPDATE"].map(
      (action) =>
        `CREATE TRIGGER issue_index_${action.toLowerCase()} AFTER ${action} ON state_records WHEN ${scope("NEW")} BEGIN ${upsert(row("NEW"))}; END`,
    ),
    `CREATE TRIGGER issue_index_delete AFTER DELETE ON state_records WHEN ${scope("OLD")} BEGIN DELETE FROM ${ISSUE_INDEX} WHERE key=OLD.key; END`,
  ],
};

export const INDEX_PAGE = `SELECT key, ${COLUMNS.join(", ")} FROM ${ISSUE_INDEX} WHERE key>? ORDER BY key LIMIT ?`;
export const INDEX_STATUS = `SELECT ok, status FROM ${ISSUE_INDEX} WHERE key=?`;
