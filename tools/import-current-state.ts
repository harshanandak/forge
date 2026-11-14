import { ForgeFailure } from "../src/contract/failure.ts";
import { canonicalJson } from "../src/core/config/pointer.ts";
import { assertNoCheckpoint } from "../src/core/state/checkpoint.ts";
import {
  StateOwner,
  verifyEventDerivedState,
} from "../src/core/state/index.ts";
import { parseRestoreJson } from "../src/core/state/restore-json.ts";
import type { StateRecord } from "../src/generated/types.ts";
import type { SqlDatabase } from "../src/ports/store.ts";
import { domain } from "../cloud/src/project.ts";
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

export function ordinaryKey(ns: string, key: string): boolean {
  return (
    ns === namespace &&
    /^(?:issue:[^:]+|(?:comment|link):[^:]+:[1-9][0-9]*|allocation:(?:issue:work-|(?:comment|link):[^:]+:))$/.test(
      key,
    )
  );
}

/** Bounded keyset reads retain only one page; admission happens before yielding each record. */
export function* workRecords(source: SqlDatabase): Generator<StateRecord> {
  let after: readonly string[] | undefined;
  for (;;) {
    const rows = source.all(
      `SELECT namespace,key,body FROM state_records${after ? " WHERE (namespace,key) > (?,?)" : ""} ORDER BY namespace,key LIMIT 128`,
      after,
    );
    for (const row of rows) {
      if (!ordinaryKey(String(row.namespace), String(row.key))) invalid();
      yield parseRestoreJson(String(row.body)) as StateRecord;
    }
    if (rows.length < 128) return;
    after = [String(rows.at(-1)!.namespace), String(rows.at(-1)!.key)];
  }
}

/** Only the exact supported standalone kernel schema is admitted; never migrate the source. */
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
      "PRAGMA user_version",
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
    let records = 0;
    for (const _record of workRecords(source)) records++;
    if (records !== manifest.records) invalid();
    return found;
  } catch {
    // Source bodies and keys may contain credentials; only the refusal category crosses this boundary.
    return invalid();
  }
}

/** Project into a disposable, initialized kernel store. The source is borrowed and read-only. */
export function currentState(
  source: SqlDatabase,
  scratch: SqlDatabase,
  manifest: SourceManifest,
  limits: Limits,
) {
  return scratch.transaction(() => {
    const nonempty = [
      "state_records",
      "state_events",
      "state_leases",
      "state_requests",
      "state_domains",
    ].some((table) => scratch.get(`SELECT 1 FROM ${table} LIMIT 1`));
    if (nonempty) invalid();
    const found = verifySource(source, manifest, scratch);
    const owner = new StateOwner(scratch, {
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
    return { records, floors, events, usage };
  });
}

/** Produce real v2 pages without retaining the image. Rehearsal and bundle files belong to the operator. */
export function* pagesOf(
  scratch: SqlDatabase,
  limits: Limits,
): Generator<Page> {
  let cursor = "start";
  for (;;) {
    const page = parseDump(
      JSON.stringify(dumpPage(scratch, cursor, limits)),
    ) as Page;
    yield page;
    if (page.next === null) return;
    cursor = page.next;
  }
}
