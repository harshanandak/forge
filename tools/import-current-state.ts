import tracker from "../schemas/tracker.json" with { type: "json" };
import config from "../src/blocks/work/schemas/config.json" with { type: "json" };
import call from "../src/blocks/work/schemas/call.output.json" with { type: "json" };
import checkpoint from "../src/blocks/work/schemas/checkpoint.input.json" with { type: "json" };
import link from "../src/blocks/work/schemas/link.json" with { type: "json" };
import { SchemaRegistry, type SchemaObject } from "../src/contract/schema.ts";
import { SCHEMA_DOCUMENTS } from "../src/generated/schemas.ts";
import { allocationFloorNumber } from "../src/core/state/allocation-floor.ts";
import { ForgeFailure } from "../src/contract/failure.ts";
import { createHash } from "node:crypto";
import { canonicalJson, isObject } from "../src/core/config/pointer.ts";
import {
  validateLeaseHolder,
  validateItemId,
  validateTimestamp,
} from "../src/generated/validators.ts";
import {
  assertNoCheckpoint,
  checkpointTables,
} from "../src/core/state/checkpoint.ts";
import {
  StateOwner,
  verifyEventDerivedState,
} from "../src/core/state/index.ts";
import { parseRestoreJson } from "../src/core/state/restore-json.ts";
import type { StateRecord, StateEvent } from "../src/generated/types.ts";
import type { SqlDatabase } from "../src/ports/store.ts";
import { domain } from "../cloud/src/project.ts";
import { durableStore } from "../cloud/src/store.ts";
import {
  dumpPage,
  dumpUsage,
  parseDump,
  type Limits,
  type Page,
} from "../cloud/src/dump.ts";

/** The operator pins file bytes and holds a stable read transaction before calling this library. */
export interface SourceManifest {
  readonly sha256: string;
  readonly eventHighWaterMark: number;
  readonly records: number;
  readonly at: string;
}
const namespace = "forge/work";
const actor = { kind: "agent", id: "current-state-import" } as const;
const family = (key: string) =>
  /^((?:comment|link):[^:]+:)[1-9][0-9]*$/.exec(key)?.[1];
const numbered = { namespace, prefix: "issue:work-", family };
const invalid = (): never => {
  throw new ForgeFailure({
    code: "INPUT_INVALID",
    message: "Unsupported or inconsistent current-state source",
    retry: "never",
  });
};

const importedKeys: Record<string, RegExp> = {
  issue: /^issue:[^:]+$/,
  comment: /^comment:[^:]+:[1-9][0-9]*$/,
  link: /^link:[^:]+:[1-9][0-9]*$/,
  landing: /^landing:work-[0-9]+:[1-9][0-9]*$/,
  reopen: /^reopen:work-[0-9]+:[1-9][0-9]*$/,
  attempt: /^attempt:work-[0-9]+:attempt-[1-9][0-9]*$/,
  evidence: /^evidence:attempt:work-[0-9]+:attempt-[1-9][0-9]*:[1-9][0-9]*$/,
  cleanup: /^cleanup:work-[0-9]+$/,
  selection: /^selection:work-[0-9]+$/,
  slots: /^slots:work-[0-9]+$/,
  allocation: /^allocation:(?:issue:work-|(?:comment|link):[^:]+:)$/,
};
function matchesKey(
  patterns: Record<string, RegExp>,
  ns: string,
  key: string,
): boolean {
  const shape = key.split(":")[0]!;
  return (
    ns === namespace &&
    Object.hasOwn(patterns, shape) &&
    patterns[shape]?.test(key) === true &&
    !/[\p{Cc}\p{Cf}]/u.test(key) &&
    (shape === "bound-lane" || !/\s/u.test(key))
  );
}
export const ordinaryKey = (ns: string, key: string): boolean =>
  matchesKey(importedKeys, ns, key);

const localKeys: Record<string, RegExp> = {
  autopilot: /^autopilot:(?:global|work-[0-9]+)$/,
  "autopilot-ask": /^autopilot-ask:work-[0-9]+$/,
  "autopilot-clock": /^autopilot-clock:work-[0-9]+$/,
  "autopilot-event": /^autopilot-event:work-[0-9]+:[1-9][0-9]*$/,
  "autopilot-merge": /^autopilot-merge:work-[0-9]+$/,
  participant: /^participant:work-[0-9]+:[1-9][0-9]*$/,
  note: /^note:attempt:work-[0-9]+:attempt-[1-9][0-9]*:[1-9][0-9]*$/,
  "bound-lane": /^bound-lane:\[.*\]:work-[0-9]+$/,
};
export const leftBehindShapes = Object.keys(localKeys).map(
  (family) => `${family}:*`,
);
export function leftBehindKey(ns: string, key: string): boolean {
  if (!matchesKey(localKeys, ns, key)) return false;
  if (!key.startsWith("bound-lane:")) return true;
  try {
    const spelling = key.slice(11, key.lastIndexOf(":")),
      tuple: unknown = JSON.parse(spelling);
    return (
      Array.isArray(tuple) &&
      tuple.length === 3 &&
      tuple.every(
        (part) => typeof part === "string" && !/[\p{Cc}\p{Cf}]/u.test(part),
      ) &&
      JSON.stringify(tuple) === spelling
    );
  } catch {
    return false;
  }
}
export const classifiedFamily = (family: string): boolean =>
  Object.hasOwn(importedKeys, family) !== Object.hasOwn(localKeys, family);

function persisted(
  schema: SchemaObject,
  remove: string,
  extra: SchemaObject = {},
) {
  const omitted = new Set(remove.split(" "));
  const properties = schema.properties as SchemaObject;
  return {
    ...schema,
    required: (schema.required as readonly string[]).filter(
      (name) => !omitted.has(name),
    ),
    properties: {
      ...Object.fromEntries(
        Object.entries(properties).filter(([name]) => !omitted.has(name)),
      ),
      ...extra,
    },
  };
}
const valueSchema = tracker.$id.replace("tracker.json", "import-current.json");
const values = new SchemaRegistry([
  ...SCHEMA_DOCUMENTS,
  {
    $id: valueSchema,
    $defs: {
      ...tracker.$defs,
      issue: persisted(
        tracker.$defs.TrackerItem,
        "lease revision updatedAt mode slots attempts selection participants",
        {
          prefix: config.properties.idPrefix,
          closeReason: tracker.$defs.CloseInput.properties.reason,
        },
      ),
      comment: persisted(tracker.$defs.CommentInput, "", {
        call: call.properties.call,
        checkpoint: persisted(checkpoint, "id"),
      }),
      link,
    },
  },
]);
const primaryValues = Object.fromEntries(
  ["issue", "comment", "link"].map((name) => [
    name,
    values.validator(valueSchema + "#/$defs/" + name),
  ]),
);

type Check = (value: unknown) => boolean;
const text: Check = (v) => typeof v === "string";
const positive: Check = (v) => Number.isSafeInteger(v) && Number(v) > 0;
const reason: Check = (v) =>
  typeof v === "string" && !!v.trim() && Array.from(v).length <= 65536;
const attemptId: Check = (v) =>
  typeof v === "string" &&
  /^attempt-[1-9][0-9]*$/.test(v) &&
  !/[\s\p{Cc}\p{Cf}]/u.test(v) &&
  positive(Number(v.slice(8)));
const hex = (v: unknown, length = 40): v is string =>
  typeof v === "string" && v.length === length && !/[^a-f0-9]/i.test(v);
const timestamp: Check = (v) => validateTimestamp(v).ok;
const named = (names: string, check: Check) =>
  Object.fromEntries(names.split(" ").map((name) => [name, check]));
const checks: Record<string, Check> = {
  ...named("id label review mode", text),
  ...named("branch worktree note", (v) => text(v) && v !== ""),
  ...named("reason claimReason", reason),
  closeReason: (v) => typeof v === "string" && Array.from(v).length <= 2000,
  withoutReceipt: (v) => reason(v) && checks.closeReason!(v),
  holder: (v) => validateLeaseHolder(v).ok,
  receipt: (v) => validateItemId(v).ok,
  ...named("pr generation baseRevision", positive),
  ...named("head mergeCommit", (v) => hex(v) || hex(v, 64)),
  sha: (v) => hex(v) && v === v.toLowerCase(),
  attempt: attemptId,
  ...named("createdAt recordedAt selectedAt expiresAt", timestamp),
  count: (n) => positive(n) && Number(n) <= 16,
  next: (v) => positive(v) || v === 0,
  supersededBy: (v) => v === "selection",
  superseded: (v) => fields(v, "supersededBy reason"),
  chosen: (v) =>
    Array.isArray(v) &&
    v.every((c) => fields(c, "attempt sha")) &&
    new Set(v.map((c) => c.attempt)).size === v.length,
  metrics: (v) =>
    isObject(v) &&
    Object.keys(v).length <= 32 &&
    Object.values(v).every(
      (x) =>
        typeof x === "string" || (typeof x === "number" && Number.isFinite(x)),
    ),
};
type Value = Record<string, unknown>;
function fields(v: unknown, need: string, extra = ""): v is Value {
  const allowed = (need + " " + extra).split(" ");
  return (
    isObject(v) &&
    need.split(" ").every((k) => Object.hasOwn(v, k)) &&
    Object.keys(v).every(
      (k) => allowed.includes(k) && checks[k]?.(v[k]) === true,
    )
  );
}
/** Persisted writer shapes; public attempt views additionally contain lease metadata. */
function workValue(key: string, v: unknown): boolean {
  const [kind, id, number, attempt] = key.split(":");
  if (
    ["landing", "reopen", "evidence"].includes(kind!) &&
    !positive(Number(key.split(":").at(-1)))
  )
    return false;
  switch (kind) {
    case "issue":
    case "comment":
    case "link":
      return isObject(v) && v.id === id && primaryValues[kind]!(v).ok;
    case "allocation":
      return allocationFloorNumber(v, key.slice(11)) !== undefined;
    case "landing":
      return (
        fields(
          v,
          "id receipt branch worktree note pr generation head mergeCommit",
        ) &&
        v.id === id &&
        String(v.pr) === number
      );
    case "reopen":
      return fields(
        v,
        "reason holder",
        "receipt withoutReceipt closeReason claimReason",
      );
    case "attempt":
      return (
        fields(v, "id holder baseRevision createdAt", "label superseded") &&
        attemptId(v.id) &&
        v.id === number
      );
    case "evidence":
      return (
        fields(v, "attempt sha holder recordedAt", "receipt review metrics") &&
        v.attempt === attempt
      );
    case "cleanup":
      return fields(v, "expiresAt");
    case "slots":
      return fields(v, "count next");
    case "selection":
      return (
        fields(v, "mode chosen reason holder selectedAt") &&
        (v.mode === "none"
          ? (v.chosen as unknown[]).length === 0
          : v.mode === "single"
            ? (v.chosen as unknown[]).length === 1
            : v.mode === "combine" && (v.chosen as unknown[]).length > 0)
      );
    default:
      return false;
  }
}
/** Bounded keyset reads retain only one page; admission happens before yielding each record. */
export function* workRecords(
  source: SqlDatabase,
  includeLocal = false,
): Generator<StateRecord> {
  let after: readonly string[] | undefined;
  for (;;) {
    const rows = source.all(
      `SELECT namespace,key,body FROM state_records${after ? " WHERE (namespace,key) > (?,?)" : ""} ORDER BY namespace,key LIMIT 128`,
      after,
    );
    for (const row of rows) {
      if (row.namespace !== namespace) continue;
      if (leftBehindKey(namespace, String(row.key))) {
        if (includeLocal)
          yield parseRestoreJson(String(row.body)) as StateRecord;
        continue;
      }
      if (!ordinaryKey(String(row.namespace), String(row.key))) invalid();
      const record = parseRestoreJson(String(row.body)) as StateRecord;
      if (!workValue(record.key, record.value)) invalid();
      yield record;
    }
    if (rows.length < 128) return;
    after = [String(rows.at(-1)!.namespace), String(rows.at(-1)!.key)];
  }
}

/** Only the exact supported standalone authority schema is admitted; never migrate the source. */
export function verifySource(
  source: SqlDatabase,
  manifest: SourceManifest,
  schema: SqlDatabase,
) {
  try {
    if (
      !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
      !Number.isSafeInteger(manifest.records) ||
      manifest.records < 0 ||
      !Number.isSafeInteger(manifest.eventHighWaterMark) ||
      manifest.eventHighWaterMark < 0 ||
      !Number.isFinite(Date.parse(manifest.at)) ||
      new Date(manifest.at).toISOString() !== manifest.at
    )
      invalid();
    for (const sql of [
      "SELECT CAST(user_version AS TEXT) AS version FROM pragma_user_version",
      "SELECT id FROM state_migrations ORDER BY id",
      "SELECT namespace,table_name,reviewed_digest FROM state_domains ORDER BY table_name",
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    ])
      if (canonicalJson(source.all(sql)) !== canonicalJson(schema.all(sql)))
        invalid();
    assertNoCheckpoint(source);
    const found = verifyEventDerivedState(
      source,
      manifest.eventHighWaterMark,
      undefined,
      numbered,
    )!;
    let sequence = 0;
    for (;;) {
      const events = source.all(
        "SELECT sequence,namespace,key,body FROM state_events WHERE sequence>? ORDER BY sequence LIMIT 128",
        [sequence],
      );
      for (const row of events) {
        if (row.namespace !== namespace) continue;
        const event = parseRestoreJson(String(row.body)) as StateEvent;
        const lease = event.type.startsWith(`${namespace}:lease.`);
        if (
          leftBehindKey(namespace, event.key) ||
          (lease &&
            event.key.startsWith("issue:") &&
            leftBehindKey(namespace, event.key.slice(6)))
        )
          continue;
        if (
          !ordinaryKey(namespace, event.key) &&
          !(
            lease &&
            event.key.startsWith("issue:") &&
            ordinaryKey(namespace, event.key.slice(6))
          )
        )
          invalid();
        if (
          event.type === `${namespace}:record.updated@1` &&
          !workValue(event.key, event.data)
        )
          invalid();
      }
      if (events.length < 128) break;
      sequence = Number(events.at(-1)!.sequence);
    }
    let records = Number(
      source.get("SELECT COUNT(*) AS n FROM state_records WHERE namespace<>?", [
        namespace,
      ])!.n,
    );
    for (const _record of workRecords(source, true)) records++;
    if (records !== manifest.records) invalid();
    return found;
  } catch {
    // Source bodies and keys may contain credentials; only the refusal category crosses this boundary.
    return invalid();
  }
}

function leftBehind(source: SqlDatabase, manifest: SourceManifest) {
  const records = source
    .all(
      `SELECT namespace, CASE
      WHEN namespace='forge/check' AND key LIKE 'runs/%' THEN 'runs/*'
      WHEN namespace='forge/memory' AND key LIKE 'note/%' THEN 'note/*'
      WHEN namespace='forge/memory' AND key LIKE 'transfer/%' THEN 'transfer/*'
      WHEN namespace='forge/memory' AND key LIKE 'meta/%' THEN 'meta/*'
      WHEN namespace='forge/core-project' AND key='identity' THEN 'identity'
      ELSE 'other' END AS shape, COUNT(*) AS count
    FROM state_records WHERE namespace<>? GROUP BY namespace,shape ORDER BY namespace,shape`,
      [namespace],
    )
    .map((row) => ({
      namespace: String(row.namespace),
      shape: String(row.shape),
      count: Number(row.count),
    }));
  let after = "";
  for (;;) {
    const keys = source.all(
      "SELECT key FROM state_records WHERE namespace=? AND key>? ORDER BY key LIMIT 128",
      [namespace, after],
    );
    for (const row of keys) {
      if (!leftBehindKey(namespace, String(row.key))) continue;
      const shape = `${String(row.key).split(":")[0]}:*`;
      const group = records.find(
        (record) => record.namespace === namespace && record.shape === shape,
      );
      if (group) group.count++;
      else records.push({ namespace, shape, count: 1 });
    }
    if (keys.length < 128) break;
    after = String(keys.at(-1)!.key);
  }
  const report = {
    format: "forge-current-left-behind/1",
    source: manifest,
    records,
    liveLeases: source.all("SELECT body FROM state_leases").reduce((n, row) => {
      const lease = parseRestoreJson(String(row.body)) as {
        releasedAt?: string;
        expiresAt: string;
      };
      return (
        n +
        Number(
          lease.releasedAt === undefined &&
            Date.parse(lease.expiresAt) > Date.parse(manifest.at),
        )
      );
    }, 0),
  };
  const bytes = canonicalJson(report);
  return {
    report,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/** Project into a disposable, initialized authority store. The source is borrowed and read-only. */
export function currentState(
  source: SqlDatabase,
  scratch: SqlDatabase,
  manifest: SourceManifest,
  limits: Limits,
) {
  try {
    return scratch.transaction(() => {
      const nonempty = [
        "state_records",
        "state_events",
        "state_leases",
        "state_requests",
        "state_domains",
        ...Object.keys(checkpointTables),
      ].some((table) => scratch.get(`SELECT 1 FROM ${table} LIMIT 1`));
      if (nonempty) invalid();
      const found = verifySource(source, manifest, scratch);
      const cloud = durableStore({
        sql: {
          exec: (sql, ...bindings) => {
            const rows = scratch.all(
              sql,
              bindings.map((value) =>
                value instanceof ArrayBuffer ? new Uint8Array(value) : value,
              ),
            );
            return { toArray: () => rows.map((row) => ({ ...row })) };
          },
        },
        transactionSync: (body) => scratch.transaction(body),
        get: invalid,
        put: invalid,
        delete: invalid,
      });
      const owner = new StateOwner(cloud, {
        now: () => Date.parse(manifest.at),
      });
      owner.initialize([domain]);
      let records = 0,
        floors = 0;
      for (const record of workRecords(source)) {
        owner.put(namespace, record.key, record.value, actor, {
          expectRevision: 0,
        });
        records++;
      }
      for (const [prefix, summary] of [
        [numbered.prefix, found] as const,
        ...(found.groups ?? []),
      ]) {
        const needed = Math.max(summary.highest, summary.earlier);
        if (
          owner.seedNumberFloor(
            namespace,
            prefix,
            { highest: needed, earlier: 0, floorRevision: 0 },
            actor,
            records + floors,
          )
        )
          floors++;
      }
      const events = records + floors;
      verifyEventDerivedState(scratch, events);
      for (const record of workRecords(source))
        if (
          canonicalJson(owner.get(namespace, record.key)?.value) !==
          canonicalJson(record.value)
        )
          invalid();
      const usage = dumpUsage(scratch, limits);
      if (
        usage.bytes > limits.maxBytes ||
        Object.values(usage.rows).some((n) => n > limits.maxRows)
      )
        throw new ForgeFailure({
          code: "RESTORE_TOO_LARGE",
          message: "Current-state projection exceeds configured caps",
          retry: "never",
        });
      return {
        records,
        floors,
        events,
        usage,
        leftBehind: leftBehind(source, manifest),
      };
    });
  } catch (error) {
    if (error instanceof ForgeFailure && error.error.code === "INPUT_INVALID")
      invalid();
    throw error;
  }
}

/** Produce real v2 pages without retaining the image. Rehearsal and bundle files belong to the operator. */
export function* pagesOf(
  scratch: SqlDatabase,
  limits: Limits,
): Generator<Page> {
  const read: SqlDatabase = {
    ...scratch,
    all: (sql, params) =>
      scratch
        .all(sql, params)
        .map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [
              key,
              typeof value === "bigint" && Number.isSafeInteger(Number(value))
                ? Number(value)
                : value,
            ]),
          ),
        ),
  };
  let cursor = "start";
  for (;;) {
    const page = parseDump(
      JSON.stringify(dumpPage(read, cursor, limits)),
    ) as Page;
    yield page;
    if (page.next === null) return;
    cursor = page.next;
  }
}
