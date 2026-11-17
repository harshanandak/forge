import { ForgeFailure } from "../src/contract/failure.ts";
import { createHash } from "node:crypto";
import { canonicalJson, isObject } from "../src/core/config/pointer.ts";
import {
  validateDeclaredWorkRecord,
  workFamilyDeclarations,
} from "../src/blocks/work/state-families.ts";
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
function invalid(observed?: { id: string; reason: string }): never {
  throw new ForgeFailure({
    code: "INPUT_INVALID",
    message: "Unsupported or inconsistent current-state source",
    retry: "never",
    ...(observed === undefined ? {} : { observed }),
  });
}

const localReason =
  "local runtime state; retained in the pre-cutover snapshot; never imported as live approvals";
export const importDispositions: Readonly<
  Record<string, { convert: boolean; reason: string }>
> = Object.fromEntries<{ convert: boolean; reason: string }>([
  ..."issue comment link landing reopen attempt evidence cleanup selection slots allocation"
    .split(" ")
    .map(
      (name) =>
        [name, { convert: true, reason: "persisted project data" }] as const,
    ),
  ..."autopilot autopilot-global autopilot-clock autopilot-ask autopilot-event autopilot-merge"
    .split(" ")
    .map((name) => [name, { convert: false, reason: localReason }] as const),
  ..."participant note bound-lane".split(" ").map(
    (name) =>
      [
        name,
        {
          convert: false,
          reason:
            "local lane authority and notes; retained in the pre-cutover snapshot",
        },
      ] as const,
  ),
]);
function disposition(key: string) {
  const names = Object.keys(workFamilyDeclarations).filter(
    (name) => workFamilyDeclarations[name]!.key.exec(key)?.[0] === key,
  );
  return names.length === 1 ? importDispositions[names[0]!] : undefined;
}
export const ordinaryKey = (ns: string, key: string): boolean =>
  ns === namespace && disposition(key)?.convert === true;
const legacyCloseReason =
  "Imported: closed before Forge required close evidence";
function admitSource(key: string, value: unknown, checkValue = true) {
  const declared = disposition(key);
  if (!declared)
    invalid({
      id: key,
      reason:
        validateDeclaredWorkRecord(key, value) ?? "WORK_VALUE_DISPOSITION",
    });
  let repaired = false;
  if (declared.convert && checkValue) {
    if (
      key.startsWith("issue:") &&
      isObject(value) &&
      value.status === "closed" &&
      value.receipt === undefined &&
      value.withoutReceipt === undefined
    ) {
      value = { ...value, withoutReceipt: legacyCloseReason };
      repaired = true;
    }
    const reason = validateDeclaredWorkRecord(key, value);
    if (reason) invalid({ id: key, reason });
  }
  return { ...declared, value, repaired };
}
interface Repairs {
  records: number;
  historicalUpdates: number;
}

/** Bounded keyset reads retain only one page; admission happens before yielding each record. */
export function* workRecords(
  source: SqlDatabase,
  repairs?: Repairs,
): Generator<StateRecord> {
  let after: readonly string[] | undefined;
  for (;;) {
    const rows = source.all(
      `SELECT namespace,key,body FROM state_records${after ? " WHERE (namespace,key) > (?,?)" : ""} ORDER BY namespace,key LIMIT 128`,
      after,
    );
    for (const row of rows) {
      if (row.namespace !== namespace) continue;
      const record = parseRestoreJson(String(row.body)) as StateRecord;
      const admitted = admitSource(record.key, record.value);
      if (!admitted.convert) continue;
      if (admitted.repaired && repairs) repairs.records++;
      yield { ...record, value: admitted.value };
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
    let sequence = 0;
    const repaired: Repairs = { records: 0, historicalUpdates: 0 };
    for (;;) {
      const events = source.all(
        "SELECT sequence,namespace,key,body FROM state_events WHERE sequence>? ORDER BY sequence LIMIT 128",
        [sequence],
      );
      for (const row of events) {
        if (row.namespace !== namespace) continue;
        const event = parseRestoreJson(String(row.body)) as StateEvent;
        const lease = event.type.startsWith(`${namespace}:lease.`);
        const key =
          lease && !disposition(event.key) && event.key.startsWith("issue:")
            ? event.key.slice(6)
            : event.key;
        if (
          admitSource(
            key,
            event.data,
            event.type === `${namespace}:record.updated@1`,
          ).repaired
        )
          repaired.historicalUpdates++;
      }
      if (events.length < 128) break;
      sequence = Number(events.at(-1)!.sequence);
    }
    const records = Number(
      source.get("SELECT COUNT(*) AS n FROM state_records")!.n,
    );
    let imported = 0;
    for (const _record of workRecords(source, repaired)) imported++;
    if (records !== manifest.records) invalid();
    const found = verifyEventDerivedState(
      source,
      manifest.eventHighWaterMark,
      undefined,
      numbered,
    )!;
    for (const [prefix, summary] of [
      [numbered.prefix, found] as const,
      ...(found.groups ?? []),
    ])
      admitSource(`allocation:${prefix}`, {
        prefix,
        number: Math.max(summary.highest, summary.earlier),
      });
    return { ...found, imported, repaired };
  } catch (error) {
    if (error instanceof ForgeFailure && error.error.observed) throw error;
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
  const local = source
    .all(
      "SELECT CASE WHEN key='autopilot:global' THEN 'autopilot-global' ELSE substr(key,1,instr(key,':')-1) END AS family,COUNT(*) AS count FROM state_records WHERE namespace=? GROUP BY family ORDER BY family",
      [namespace],
    )
    .flatMap((row) => {
      const name = String(row.family),
        entry = importDispositions[name];
      return entry?.convert === false
        ? [
            {
              namespace,
              shape: `${name}:*`,
              count: Number(row.count),
              reason: entry.reason,
            },
          ]
        : [];
    });
  const report = {
    format: "forge-current-left-behind/1",
    source: manifest,
    records: [...records, ...local],
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
        get: () => invalid(),
        put: () => invalid(),
        delete: () => invalid(),
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
      if (records !== found.imported) invalid();
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
        repaired: found.repaired,
        usage,
        leftBehind: leftBehind(source, manifest),
      };
    });
  } catch (error) {
    if (
      error instanceof ForgeFailure &&
      error.error.code === "INPUT_INVALID" &&
      !error.error.observed
    )
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
