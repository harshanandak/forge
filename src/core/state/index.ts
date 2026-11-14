import { createHash } from "node:crypto";
import { ForgeFailure } from "../../contract/failure.ts";
import { decideLease } from "../../contract/lease.ts";
import {
  validateActor,
  validateBlockId,
  validateLeaseRecord,
  validateLeaseHolder,
  validateStateRecord,
  validateStateEvent,
} from "../../generated/validators.ts";
import type {
  Actor,
  LeaseHolder,
  LeaseRecord,
  StateEvent,
  StateRecord,
} from "../../generated/types.ts";
import type { ClockPort } from "../../ports/clock.ts";
import type {
  BatchEntry,
  BatchOptions,
  DeleteOptions,
  DeletableStateClient,
  HistoryOptions,
  PutOptions,
  RangeOptions,
} from "../../ports/state.ts";
import type { SqlDatabase, SqlRow, SqlValue } from "../../ports/store.ts";
import type { Handle } from "../../ports/lifetime.ts";
import {
  baseline,
  stateMigrations,
  migrate,
  type Migration,
} from "./migrations.ts";
import { registerTables, exportTables, type DomainData } from "./domains.ts";
import { parseRestoreJson } from "./restore-json.ts";
import {
  checkpointTables,
  assertNoCheckpoint,
  readReplayStart,
} from "./checkpoint.ts";

/** Optional storage capability supplied by trusted assembly; the locked SQL port stays unchanged. */
export interface StateImageStore extends SqlDatabase {
  exportImage(inspect?: (image: SqlDatabase) => void): Uint8Array;
  restoreImage(
    image: Uint8Array,
    validate: (candidate: SqlDatabase) => void,
    prepare: (candidate: SqlDatabase) => void,
    verify: () => void,
  ): void;
}

export interface Fence {
  readonly subject: string;
  readonly holder: LeaseHolder;
  readonly generation: number;
}
export interface WriteOptions extends PutOptions {
  readonly requestId?: string;
  readonly fence?: Fence;
  /** Revisions used to validate this write; 0 asserts that a key remains absent. */
  readonly readSet?: readonly {
    readonly key: string;
    readonly expectRevision: number;
  }[];
}
/** Guards a batch write applies to the whole batch (see putMany). */
export interface BatchWriteOptions {
  readonly fence?: Fence;
  readonly readSet?: WriteOptions["readSet"];
}
export interface DeleteWriteOptions extends DeleteOptions {
  readonly fence?: Fence;
  readonly guard?: () => boolean;
}
/** What a numbered write's builder returns: the value, and any records it depends on. */
export interface NumberedBuild {
  readonly value: unknown;
  readonly readSet?: WriteOptions["readSet"];
}
export interface NumberedOptions {
  readonly fence?: Fence;
  /** With no floor, refuse with this message when live keys or record history exist, instead of backfilling. */
  readonly refuseMissing?: string;
}
export interface AcquireOptions extends BatchOptions {
  readonly metadata?: unknown;
  readonly entries?: readonly BatchEntry[];
}
export interface Snapshot {
  readonly image: string;
  readonly eventHighWaterMark: number;
  readonly domains: readonly DomainData[];
  readonly format: "forge.state/1";
  readonly records: readonly StateRecord[];
  readonly events: readonly StateEvent[];
  readonly leases: readonly {
    readonly namespace: string;
    readonly lease: LeaseRecord;
  }[];
  readonly requests: readonly {
    readonly namespace: string;
    readonly requestId: string;
    readonly fingerprint: string;
    readonly result: string;
  }[];
}
/** Only trusted assembly supplies registrations; clients never receive SQL or this interface. */
export interface ReviewedDomain {
  readonly namespace: string;
  readonly reviewedDigest: string;
  readonly migrations: readonly Migration[];
  readonly tables: readonly string[];
}

function invalid(message: string): never {
  throw new ForgeFailure({ code: "INPUT_INVALID", message, retry: "never" });
}
function json(value: unknown): string {
  const seen = new Set<object>();
  const walk = (input: unknown): unknown => {
    if (
      input === null ||
      typeof input === "string" ||
      typeof input === "boolean"
    )
      return input;
    if (typeof input === "number" && Number.isFinite(input)) return input;
    if (typeof input !== "object" || seen.has(input))
      return invalid("State values must be finite JSON without cycles");
    seen.add(input);
    let result: unknown;
    if (Array.isArray(input)) {
      for (let index = 0; index < input.length; index++)
        if (!Object.hasOwn(input, index))
          invalid("State arrays must not contain holes");
      result = input.map(walk);
    } else {
      if (
        Object.getPrototypeOf(input) !== Object.prototype &&
        Object.getPrototypeOf(input) !== null
      )
        return invalid("State values must be plain JSON");
      result = Object.fromEntries(
        Object.keys(input)
          .sort()
          .map((key) => [key, walk((input as Record<string, unknown>)[key])]),
      );
    }
    seen.delete(input);
    return result;
  };
  return JSON.stringify(walk(value));
}
function body<T>(row: SqlRow | undefined): T | undefined {
  return row === undefined ? undefined : (JSON.parse(String(row.body)) as T);
}
function keyValid(key: string): void {
  if (key.length === 0 || key.length > 500)
    invalid("Key must contain 1 to 500 characters");
}
function wellFormedText(value: string, position: string): void {
  if (!value.isWellFormed())
    invalid(`${position} must be well-formed UTF-16 text`);
}
/** The longest stored floor text accepted: the wrapper of a two-field value is well under this. */
const FLOOR_TEXT_MAX = 4096;
/** The stored floor's number; any value that is not the exact floor shape is refused, never read as zero. */
function floorNumber(value: unknown, prefix: string): number {
  const floor = value as { prefix?: unknown; number?: unknown } | null;
  if (
    typeof floor !== "object" ||
    floor === null ||
    Object.keys(floor).length !== 2 ||
    floor.prefix !== prefix ||
    typeof floor.number !== "number" ||
    !Number.isSafeInteger(floor.number) ||
    floor.number < 0
  )
    return invalid("Invalid allocation record");
  return floor.number;
}
function copyReadSet(value: unknown): WriteOptions["readSet"] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return invalid("Invalid read set");
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== "object")
      return invalid("Invalid read-set revision");
    const read = entry as Record<string, unknown>;
    if (
      typeof read.key !== "string" ||
      typeof read.expectRevision !== "number" ||
      !Number.isSafeInteger(read.expectRevision) ||
      read.expectRevision < 0
    )
      return invalid("Invalid read-set revision");
    keyValid(read.key);
    return { key: read.key, expectRevision: read.expectRevision };
  });
}
function namespaceValid(namespace: string): void {
  if (!validateBlockId(namespace).ok) invalid("Invalid namespace");
}

function upperBound(prefix: string): string | undefined {
  // SQLite's binary UTF-8 order needs a code-point successor, carrying past U+10FFFF.
  const points = Array.from(prefix);
  while (points.length > 0) {
    const point = points.pop()!.codePointAt(0)!;
    if (point === 0x10ffff) continue;
    return (
      points.join("") +
      String.fromCodePoint(point === 0xd7ff ? 0xe000 : point + 1)
    );
  }
  return undefined;
}

// The same constructors define live history and the exact history restore accepts.
function recordEvent(record: StateRecord, requestId?: string): StateEvent {
  return {
    type: `${record.namespace}:record.updated@1`,
    namespace: record.namespace,
    key: record.key,
    revision: record.revision,
    at: record.updatedAt,
    actor: record.updatedBy,
    ...(requestId === undefined ? {} : { requestId }),
    data: record.value,
  };
}
function deletionEvent(
  record: Pick<StateRecord, "namespace" | "key" | "revision">,
  actor: Actor,
  at: string,
): StateEvent {
  return {
    type: `${record.namespace}:record.deleted@1`,
    namespace: record.namespace,
    key: record.key,
    revision: record.revision + 1,
    at,
    actor,
  };
}
function acquisitionInput(options?: AcquireOptions) {
  if (options?.entries !== undefined)
    return {
      entries: options.entries,
      ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    };
  return options?.metadata === undefined ? {} : { metadata: options.metadata };
}
function acquisitionEvent(
  namespace: string,
  lease: LeaseRecord,
  previous: LeaseRecord | undefined,
  at: string,
  requestId: string,
  options?: AcquireOptions,
): StateEvent {
  const decision = decideLease(previous, {
    mode: "acquire",
    subject: lease.subject,
    holder: lease.holder,
    nowMs: Date.parse(at),
  });
  if (!decision.ok || decision.kind !== "acquired")
    invalid("Invalid acquisition event");
  return {
    type: `${namespace}:lease.${decision.reacquired ? "reacquired" : "acquired"}@1`,
    namespace,
    key: lease.subject,
    revision: lease.generation,
    at,
    actor: lease.holder.actor,
    requestId,
    data: {
      lease,
      previous: previous ?? null,
      ...(options === undefined ? {} : { options }),
    },
  };
}
function changedLeaseEvent(
  namespace: string,
  previous: LeaseRecord,
  holder: LeaseHolder,
  at: string,
  expiresAt?: string,
): StateEvent {
  const lease =
    expiresAt === undefined
      ? { ...previous, holder, releasedAt: at }
      : { ...previous, holder, expiresAt };
  return {
    type: `${namespace}:lease.${expiresAt === undefined ? "released" : "renewed"}@1`,
    namespace,
    key: lease.subject,
    revision: lease.generation,
    at,
    actor: lease.holder.actor,
    data: lease,
  };
}

interface ReceiptPlan {
  fingerprint: string;
  result: string;
  kind: "put" | "acquire";
  readSet: WriteOptions["readSet"];
  fence: Fence | null;
  durationMs: number | undefined;
}
function digest(value: unknown): string {
  return createHash("sha256").update(json(value)).digest("hex");
}
function receiptPlan(row: SqlRow): ReceiptPlan {
  const input = parseRestoreJson(String(row.fingerprint)) as Record<
    string,
    unknown
  >;
  const result = parseRestoreJson(String(row.result));
  if (
    !input ||
    Array.isArray(input) ||
    json(input) !== row.fingerprint ||
    (input.kind !== "put" && input.kind !== "acquire")
  )
    invalid("Invalid imported request JSON");
  const fence = input.kind === "put" ? (input.fence as Fence | null) : null;
  if (
    fence !== null &&
    (!fence ||
      typeof fence.subject !== "string" ||
      !validateLeaseHolder(fence.holder).ok ||
      !Number.isSafeInteger(fence.generation) ||
      json(fence) !==
        json({
          subject: fence.subject,
          holder: fence.holder,
          generation: fence.generation,
        }))
  )
    invalid("Invalid imported request fence");
  return {
    fingerprint: digest(input),
    result: digest(result),
    kind: input.kind,
    readSet: input.kind === "put" ? copyReadSet(input.readSet) : undefined,
    fence,
    durationMs:
      typeof input.durationMs === "number" ? input.durationMs : undefined,
  };
}

function validateReceipt(
  row: SqlRow,
  events: {
    event: StateEvent | undefined;
    revision: (key: string) => number;
    lease: (subject: string) => LeaseRecord | undefined;
    plan: ReceiptPlan;
  },
): void {
  let input: Record<string, unknown>;
  let result: unknown;
  try {
    input = parseRestoreJson(String(row.fingerprint)) as Record<
      string,
      unknown
    >;
    result = parseRestoreJson(String(row.result));
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      json(input) !== row.fingerprint
    )
      invalid("Invalid imported request fingerprint");
    json(result);
  } catch {
    invalid("Invalid imported request JSON");
  }
  const event = events.event;
  if (!event) invalid("Imported request needs exactly one matching event");
  if (
    digest(input) !== events.plan.fingerprint ||
    digest(result) !== events.plan.result
  )
    invalid("Invalid imported request JSON");
  if (input.kind === "put") {
    const record = result as StateRecord;
    const readSet = copyReadSet(input.readSet);
    if (
      !validateStateRecord(record).ok ||
      !Number.isSafeInteger(record.revision) ||
      event.type !== `${event.namespace}:record.updated@1` ||
      json(record) !==
        json({
          namespace: event.namespace,
          key: event.key,
          revision: event.revision,
          value: event.data,
          updatedAt: event.at,
          updatedBy: event.actor,
        }) ||
      json(input) !==
        json({
          kind: "put",
          key: event.key,
          value: event.data,
          actor: event.actor,
          revision: events.revision(event.key),
          fence: input.fence,
          ...(readSet === undefined ? {} : { readSet }),
        })
    )
      invalid("Imported put receipt does not match its operation");
    if (readSet !== undefined) {
      for (const read of readSet)
        if (events.revision(read.key) !== read.expectRevision)
          invalid("Imported request read set does not match accepted history");
    }
    if (input.fence !== null) {
      const fence = input.fence as Fence;
      if (
        !fence ||
        typeof fence !== "object" ||
        typeof fence.subject !== "string" ||
        !validateLeaseHolder(fence.holder).ok ||
        !Number.isSafeInteger(fence.generation) ||
        json(fence) !==
          json({
            subject: fence.subject,
            holder: fence.holder,
            generation: fence.generation,
          })
      )
        invalid("Invalid imported request fence");
      const lease = events.lease(fence.subject);
      if (lease !== undefined && !validateLeaseRecord(lease).ok)
        invalid("Invalid imported request lease history");
      if (
        !decideLease(lease, {
          mode: "held",
          ...fence,
          nowMs: Date.parse(event.at),
        }).ok
      )
        invalid("Imported request fence does not match its lease");
    }
  } else if (input.kind === "acquire") {
    const lease = result as LeaseRecord;
    const data = event.data as {
      lease?: unknown;
      previous?: LeaseRecord | null;
      options?: AcquireOptions;
    } | null;
    const duration = input.durationMs;
    if (
      !validateLeaseRecord(lease).ok ||
      !Number.isSafeInteger(lease.generation) ||
      !data ||
      typeof data !== "object" ||
      json(data.lease) !== json(lease) ||
      (data.previous !== null && !validateLeaseRecord(data.previous).ok) ||
      event.key !== lease.subject ||
      event.revision !== lease.generation ||
      json(event.actor) !== json(lease.holder.actor) ||
      typeof duration !== "number" ||
      !Number.isSafeInteger(duration) ||
      duration <= 0 ||
      !Number.isSafeInteger(Date.parse(event.at) + duration) ||
      lease.expiresAt !==
        new Date(Date.parse(event.at) + duration).toISOString() ||
      lease.releasedAt !== undefined ||
      json(input) !==
        json({
          kind: "acquire",
          subject: lease.subject,
          holder: lease.holder,
          durationMs: duration,
          ...acquisitionInput(data.options),
        })
    )
      invalid("Imported acquisition receipt does not match its operation");
    for (const read of copyReadSet(data.options?.readSet) ?? [])
      if (events.revision(read.key) !== read.expectRevision)
        invalid("Imported request read set does not match accepted history");
    const decision = decideLease(data.previous ?? undefined, {
      mode: "acquire",
      subject: lease.subject,
      holder: lease.holder,
      nowMs: Date.parse(event.at),
    });
    if (
      !decision.ok ||
      decision.kind !== "acquired" ||
      decision.generation !== lease.generation ||
      event.type !==
        `${event.namespace}:lease.${decision.reacquired ? "reacquired" : "acquired"}@1`
    )
      invalid("Imported acquisition receipt does not match its event");
  } else invalid("Unknown imported request operation");
}

export class RestoreConsistencyFailure extends ForgeFailure {
  readonly table: string;
  readonly key: string;
  constructor(table: string, key: string) {
    super({
      code: "INPUT_INVALID",
      message: `Inconsistent imported ${table} key ${key}`,
      retry: "never",
    });
    this.name = "RestoreConsistencyFailure";
    this.table = table;
    this.key = key;
  }
}

/** Which numbered keys a restore replay reports on: those in `namespace` whose key is `prefix` and a number. */
export interface NumberedRequest {
  readonly namespace: string;
  readonly prefix: string;
  /** Also report every other prefix this maps a numbered key in `namespace` to; the caller names them, never core. */
  readonly family?: (key: string) => string | undefined;
}
/**
 * The highest number any accepted record under the prefix ever held, the highest earlier floor value, and the
 * floor key's last verified revision (0 when it has no history), read from the replay's parsed event types.
 */
export interface NumberedSummary {
  readonly highest: number;
  readonly earlier: number;
  readonly floorRevision: number;
  /** With a `family`, one summary per other observed prefix, in prefix order. */
  readonly groups?: ReadonlyMap<string, NumberedSummary>;
}
/** The number after `prefix` when it is a positive decimal (the rule #highest applies in SQL); an unsafe one is refused. */
function suffixNumber(key: string, prefix: string): number | undefined {
  if (!key.startsWith(prefix)) return undefined;
  const text = key.slice(prefix.length);
  if (!/^[1-9][0-9]*$/.test(text)) return undefined;
  const number = Number(text);
  if (!Number.isSafeInteger(number))
    return invalid("Allocation history holds an unsafe number");
  return number;
}

const restorePageSize = 16;
/** Largest accepted restore page size; a larger value is rejected, never clamped. */
const restorePageMax: number = 1000;

function* restoredRows(
  db: SqlDatabase,
  table: string,
  columns: string,
  keys: readonly string[],
  pageSize: number,
  startAfter?: readonly SqlValue[],
  firstPage?: readonly SqlRow[],
): Generator<SqlRow> {
  let after = startAfter;
  for (;;) {
    const rows =
      firstPage ??
      db.all(
        `SELECT ${columns} FROM ${table}${after === undefined ? "" : ` WHERE (${keys.join(",")}) > (${keys.map(() => "?").join(",")})`} ORDER BY ${keys.join(",")} LIMIT ?`,
        [...(after ?? []), pageSize],
      );
    firstPage = undefined;
    for (const row of rows) yield row;
    if (rows.length < pageSize) return;
    after = keys.map((column) => rows.at(-1)![column]!);
  }
}

/** Reproduce all event-derived tables before accepting an image. Domain tables and
 * registration/migration ledgers have no event provenance; schema and FK checks cover them. */
export function verifyEventDerivedState(
  candidate: SqlDatabase,
  highWaterMark: number,
  pageSize: number = restorePageSize,
  numbered?: NumberedRequest,
  // Trusted callers verifying older images supply the capability from their validated ledger.
  checkpointCapable = true,
): NumberedSummary | undefined {
  if (!Number.isSafeInteger(highWaterMark) || highWaterMark < 0)
    throw new RestoreConsistencyFailure("state_events", "high-water mark");
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize <= 0 ||
    pageSize > restorePageMax
  )
    throw new RestoreConsistencyFailure("state_events", "high-water mark");
  const rows = (
    table: string,
    columns: string,
    keys: readonly string[],
    startAfter?: readonly SqlValue[],
    firstPage?: readonly SqlRow[],
  ) =>
    restoredRows(
      candidate,
      table,
      columns,
      keys,
      pageSize,
      startAfter,
      firstPage,
    );
  const { checkpoint, receipts } = readReplayStart(
    candidate,
    pageSize,
    checkpointCapable,
  );
  const records = new Map<string, { revision: number; digest: string }>();
  const recordRevisions = new Map<string, number>();
  const leases = new Map<string, LeaseRecord>();
  const requests = new Set<string>();
  const plans = new Map<string, ReceiptPlan | boolean>();
  const key = (namespace: string, name: string): string =>
    json([namespace, name]);
  for (const [namespace, name, , revision, digest] of checkpoint?.live ?? []) {
    const id = key(namespace, name);
    records.set(id, { revision, digest: digest.slice("sha256:".length) });
    recordRevisions.set(id, revision);
  }
  const reject = (table: string, name: string): never => {
    throw new RestoreConsistencyFailure(table, name);
  };
  const rowKey = (table: string, row: SqlRow, column: string): string => {
    const namespace = row.namespace;
    const name = row[column];
    if (typeof namespace !== "string" || typeof name !== "string")
      // Preserve main's failure label, but never use coerced values for a lookup.
      return reject(table, key(String(namespace), String(name)));
    return key(namespace, name);
  };
  const inspect = (table: string, name: string, check: () => void): void => {
    try {
      check();
    } catch (error) {
      if (error instanceof RestoreConsistencyFailure) throw error;
      reject(table, name);
    }
  };
  // Read only receipt constraints and digests before replay, never retain their value bodies.
  for (const row of rows(
    "state_requests",
    "namespace,request_id,fingerprint,result",
    ["namespace", "request_id"],
    undefined,
    receipts,
  )) {
    if (typeof row.namespace !== "string" || typeof row.request_id !== "string")
      continue;
    const id = key(row.namespace, row.request_id);
    try {
      plans.set(id, receiptPlan(row));
    } catch {
      plans.set(id, false);
    }
  }
  for (const [namespace, name, , fingerprint, result] of checkpoint?.receipts ??
    []) {
    const id = key(namespace, name);
    const plan = plans.get(id);
    if (
      !plan ||
      typeof plan === "boolean" ||
      `sha256:${plan.fingerprint}` !== fingerprint ||
      `sha256:${plan.result}` !== result
    )
      reject("state_requests", id);
    requests.add(id);
    plans.set(id, true);
  }
  // Two numbers per observed prefix, folded from rows as they are verified: never the events or the keys themselves.
  const tally = new Map<string, { highest: number; earlier: number }>();
  const slot = (prefix: string) => {
    if (!tally.has(prefix)) tally.set(prefix, { highest: 0, earlier: 0 });
    return tally.get(prefix)!;
  };
  if (numbered) slot(numbered.prefix);
  // A floor key names its prefix; any other key belongs to the prefix its number follows.
  const groupOf = (namespace: string, name: string, floor: boolean) => {
    if (numbered?.namespace !== namespace) return undefined;
    const prefix = floor ? name.slice("allocation:".length) : name;
    if (floor && !name.startsWith("allocation:")) return undefined;
    if (floor ? prefix === numbered.prefix : name.startsWith(numbered.prefix))
      return numbered.prefix;
    const family = numbered.family?.(floor ? `${prefix}1` : name);
    return !floor || family === prefix ? family : undefined;
  };
  const number = (namespace: string, name: string): void => {
    const prefix = groupOf(namespace, name, false);
    if (prefix !== undefined)
      slot(prefix).highest = Math.max(
        slot(prefix).highest,
        suffixNumber(name, prefix) ?? 0,
      );
  };
  for (const [namespace, name, , revision] of checkpoint?.deleted ?? []) {
    recordRevisions.set(key(namespace, name), revision);
    number(namespace, name);
  }
  const reserved = (event: StateEvent): void => {
    const prefix = groupOf(event.namespace, event.key, true);
    if (prefix !== undefined)
      try {
        slot(prefix).earlier = Math.max(
          slot(prefix).earlier,
          floorNumber(event.data, prefix),
        );
      } catch {
        // A value that is not a floor reserves nothing.
      }
  };
  let sequence = checkpoint?.coveredSequence ?? 0;
  for (const row of rows(
    "state_events",
    "sequence,namespace,key,body",
    ["sequence"],
    checkpoint === undefined ? undefined : [checkpoint.coveredSequence],
  )) {
    const id = rowKey("state_events", row, "key");
    sequence++;
    if (row.sequence !== sequence && row.sequence !== BigInt(sequence))
      reject("state_events", id);
    inspect("state_events", id, () => {
      const event = parseRestoreJson(String(row.body)) as StateEvent;
      if (
        !validateStateEvent(event).ok ||
        !Number.isSafeInteger(event.revision) ||
        event.namespace !== row.namespace ||
        event.key !== row.key
      )
        reject("state_events", id);

      if (event.requestId !== undefined) {
        const request = key(event.namespace, event.requestId);
        if (requests.has(request)) reject("state_requests", request);
        requests.add(request);
        const plan = plans.get(request);
        if (plan && typeof plan !== "boolean") {
          try {
            const result =
              plan.kind === "put"
                ? {
                    namespace: event.namespace,
                    key: event.key,
                    revision: event.revision,
                    value: event.data,
                    updatedAt: event.at,
                    updatedBy: event.actor,
                  }
                : (event.data as { lease: LeaseRecord }).lease;
            const options = (
              event.data as { options?: AcquireOptions } | undefined
            )?.options;
            const input =
              plan.kind === "put"
                ? {
                    kind: "put",
                    key: event.key,
                    value: event.data,
                    actor: event.actor,
                    revision: records.get(id)?.revision ?? 0,
                    fence: plan.fence,
                    ...(plan.readSet === undefined
                      ? {}
                      : { readSet: plan.readSet }),
                  }
                : {
                    kind: "acquire",
                    subject: event.key,
                    holder: (result as LeaseRecord).holder,
                    durationMs: plan.durationMs,
                    ...acquisitionInput(options),
                  };
            const row = {
              namespace: event.namespace,
              request_id: event.requestId,
              fingerprint: json(input),
              result: json(result),
            };
            const events = {
              event,
              plan,
              revision: (name: string): number =>
                records.get(key(event.namespace, name))?.revision ?? 0,
              lease: (subject: string): LeaseRecord | undefined =>
                leases.get(key(event.namespace, subject)),
            };
            validateReceipt(row, events);
            plans.set(request, true);
          } catch {
            plans.set(request, false);
          }
        }
      }
      if (event.type === `${event.namespace}:record.updated@1`) {
        if (event.revision !== (recordRevisions.get(id) ?? 0) + 1)
          reject("state_records", id);
        const record: StateRecord = {
          namespace: event.namespace,
          key: event.key,
          revision: event.revision,
          value: event.data,
          updatedAt: event.at,
          updatedBy: event.actor,
        };
        if (json(event) !== json(recordEvent(record, event.requestId)))
          reject("state_events", id);
        records.set(id, { revision: record.revision, digest: digest(record) });
        recordRevisions.set(id, record.revision);
        reserved(event);
      } else if (event.type === `${event.namespace}:record.deleted@1`) {
        const previous = records.get(id);
        if (
          !previous ||
          json(event) !==
            json(
              deletionEvent(
                {
                  namespace: event.namespace,
                  key: event.key,
                  revision: previous.revision,
                },
                event.actor,
                event.at,
              ),
            )
        )
          reject("state_records", id);
        records.delete(id);
        recordRevisions.set(id, event.revision);
        number(event.namespace, event.key);
      } else {
        const prior = leases.get(id);
        let lease: LeaseRecord;
        if (
          event.type === `${event.namespace}:lease.acquired@1` ||
          event.type === `${event.namespace}:lease.reacquired@1`
        ) {
          const data = event.data as {
            lease: LeaseRecord;
            previous: LeaseRecord | null;
            options?: AcquireOptions;
          };
          lease = data.lease;
          if (
            json(event) !==
              json(
                acquisitionEvent(
                  event.namespace,
                  lease,
                  prior,
                  event.at,
                  event.requestId!,
                  data.options,
                ),
              ) ||
            !validateLeaseRecord(lease).ok
          )
            reject("state_leases", id);
          const decision = decideLease(prior, {
            mode: "acquire",
            subject: event.key,
            holder: lease.holder,
            nowMs: Date.parse(event.at),
          });
          if (
            !decision.ok ||
            decision.kind !== "acquired" ||
            decision.generation !== lease.generation ||
            event.type !==
              `${event.namespace}:lease.${decision.reacquired ? "reacquired" : "acquired"}@1` ||
            lease.releasedAt !== undefined ||
            Date.parse(lease.expiresAt) <= Date.parse(event.at) ||
            event.requestId === undefined
          )
            reject("state_leases", id);
        } else if (
          event.type === `${event.namespace}:lease.renewed@1` ||
          event.type === `${event.namespace}:lease.released@1`
        ) {
          lease = event.data as LeaseRecord;
          if (!prior || !validateLeaseRecord(lease).ok)
            reject("state_leases", id);
          if (event.type === `${event.namespace}:lease.renewed@1`) {
            if (
              !decideLease(prior, {
                mode: "held",
                subject: event.key,
                holder: lease.holder,
                generation: lease.generation,
                nowMs: Date.parse(event.at),
              }).ok ||
              json(event) !==
                json(
                  changedLeaseEvent(
                    event.namespace,
                    prior!,
                    lease.holder,
                    event.at,
                    lease.expiresAt,
                  ),
                ) ||
              Date.parse(lease.expiresAt) <= Date.parse(event.at)
            )
              reject("state_leases", id);
          } else if (
            !decideLease(prior, {
              mode: "held",
              subject: event.key,
              holder: lease.holder,
              generation: lease.generation,
              nowMs: Date.parse(event.at),
            }).ok ||
            json(event) !==
              json(
                changedLeaseEvent(
                  event.namespace,
                  prior!,
                  lease.holder,
                  event.at,
                ),
              )
          )
            reject("state_leases", id);
        } else return reject("state_events", id);
        if (
          lease.subject !== event.key ||
          lease.generation !== event.revision ||
          !Number.isSafeInteger(lease.generation) ||
          json(lease.holder.actor) !== json(event.actor)
        )
          reject("state_leases", id);
        leases.set(id, lease);
      }
    });
  }
  if (sequence !== highWaterMark) reject("state_events", "high-water mark");
  const verifyRows = (
    table: string,
    columns: string,
    keys: readonly string[],
    check: (row: SqlRow) => void,
  ): void => {
    for (const row of rows(table, columns, keys)) {
      try {
        check(row);
      } catch (error) {
        if (!(error instanceof RestoreConsistencyFailure)) throw error;
        // Only unverified keys remain in replay state; scan that suffix by rowid.
        let after: readonly SqlValue[] = [];
        for (;;) {
          let page: readonly SqlRow[];
          try {
            page = candidate.all(
              `SELECT rowid,${columns} FROM ${table} WHERE (${keys.join(",")}) >= (${keys.map(() => "?").join(",")})${after.length ? " AND rowid > ?" : ""} ORDER BY rowid LIMIT ?`,
              [...keys.map((column) => row[column]!), ...after, pageSize],
            );
          } catch {
            throw error;
          }
          for (const remaining of page) check(remaining);
          // Keep the original rejection even if the candidate changes mid-read.
          if (page.length < pageSize) throw error;
          after = [page.at(-1)!.rowid!];
        }
      }
    }
  };
  const verifyRecord = (row: SqlRow): void => {
    const id = rowKey("state_records", row, "key");
    inspect("state_records", id, () => {
      const record = parseRestoreJson(String(row.body)) as StateRecord;
      if (
        !validateStateRecord(record).ok ||
        !records.has(id) ||
        record.namespace !== row.namespace ||
        record.key !== row.key ||
        digest(record) !== records.get(id)?.digest ||
        record.revision !== records.get(id)?.revision ||
        record.revision !== Number(row.revision)
      )
        reject("state_records", id);
      records.delete(id);
      number(row.namespace as string, row.key as string);
    });
  };
  verifyRows(
    "state_records",
    "namespace,key,revision,body",
    ["namespace", "key"],
    verifyRecord,
  );
  if (records.size) reject("state_records", records.keys().next().value!);
  const verifyLease = (row: SqlRow): void => {
    const id = rowKey("state_leases", row, "subject");
    inspect("state_leases", id, () => {
      const lease = parseRestoreJson(String(row.body)) as LeaseRecord;
      if (
        !leases.has(id) ||
        json(lease) !== json(leases.get(id)) ||
        lease.generation !== Number(row.generation)
      )
        reject("state_leases", id);
      leases.delete(id);
    });
  };
  verifyRows(
    "state_leases",
    "namespace,subject,generation,body",
    ["namespace", "subject"],
    verifyLease,
  );
  if (leases.size) reject("state_leases", leases.keys().next().value!);
  const verifyRequest = (row: SqlRow): void => {
    const id = rowKey("state_requests", row, "request_id");
    inspect("state_requests", id, () => {
      namespaceValid(row.namespace as string);
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.request_id as string))
        reject("state_requests", id);
      if (plans.get(id) !== true) reject("state_requests", id);
      requests.delete(id);
    });
  };
  verifyRows(
    "state_requests",
    "namespace,request_id,fingerprint,result",
    ["namespace", "request_id"],
    verifyRequest,
  );
  if (requests.size) reject("state_requests", requests.values().next().value!);
  if (numbered === undefined) return undefined;
  const summary = (prefix: string): NumberedSummary => ({
    ...tally.get(prefix)!,
    floorRevision:
      recordRevisions.get(key(numbered.namespace, `allocation:${prefix}`)) ?? 0,
  });
  const others = [...tally.keys()].filter(
    (prefix) => prefix !== numbered.prefix,
  );
  return {
    ...summary(numbered.prefix),
    ...(numbered.family === undefined
      ? {}
      : {
          groups: new Map(
            others.sort().map((prefix) => [prefix, summary(prefix)] as const),
          ),
        }),
  };
}

// Only these ledgers contain setup metadata that restore may replace in a nonempty store.
const metadataTables = new Set(["state_migrations", "state_domains"]);
const stateDataTables = new Set([
  ...Object.keys(checkpointTables),
  "state_records",
  "state_events",
  "state_leases",
  "state_requests",
]);
function dataTables(db: SqlDatabase): readonly string[] {
  return db
    .all("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
    .map((row) => String(row.name))
    .filter(
      (name) =>
        !name.toLowerCase().startsWith("sqlite_") && !metadataTables.has(name),
    );
}
function assertRegistered(db: SqlDatabase): void {
  const registered = new Set(
    db.all("SELECT table_name FROM state_domains").map((row) => row.table_name),
  );
  for (const table of dataTables(db))
    if (!stateDataTables.has(table) && !registered.has(table))
      invalid(`Unregistered user table: ${table}`);
}

export class StateOwner {
  readonly #db: SqlDatabase;
  readonly #clock: ClockPort;
  #knownMigrations = new Set(stateMigrations.map((migration) => migration.id));
  #domains: readonly ReviewedDomain[] = [];
  constructor(db: SqlDatabase, clock: ClockPort) {
    this.#db = db;
    this.#clock = clock;
  }

  /** Explicit write setup; constructing an owner or reading never initializes a store. */
  initialize(domains: readonly ReviewedDomain[] = []): void {
    for (const domain of domains) {
      namespaceValid(domain.namespace);
      if (
        !domain.namespace.startsWith("forge/") ||
        !/^sha256:[0-9a-f]{64}$/.test(domain.reviewedDigest)
      )
        invalid("Domain tables require a reviewed first-party registration");
    }
    migrate(
      this.#db,
      [...stateMigrations, ...domains.flatMap((domain) => domain.migrations)],
      () => {
        registerTables(
          this.#db,
          domains.flatMap((domain) =>
            domain.tables.map((table) => ({
              namespace: domain.namespace,
              reviewedDigest: domain.reviewedDigest,
              table,
            })),
          ),
        );
        assertRegistered(this.#db);
      },
    );
    this.#knownMigrations = new Set([
      ...stateMigrations.map((migration) => migration.id),
      ...domains.flatMap((domain) =>
        domain.migrations.map((migration) => migration.id),
      ),
    ]);
    this.#domains = domains;
  }

  client(namespace: string, actor: Actor): DeletableStateClient {
    namespaceValid(namespace);
    if (!validateActor(actor).ok) invalid("Invalid actor");
    const boundActor = Object.freeze(JSON.parse(json(actor)) as Actor);
    return Object.freeze({
      get: (key: string) => this.get(namespace, key),
      put: (key: string, value: unknown, options: PutOptions) =>
        this.put(namespace, key, value, { ...boundActor }, options),
      delete: (key: string, options: DeleteOptions) =>
        this.delete(namespace, key, { ...boundActor }, options),
      putMany: (entries: readonly BatchEntry[], options?: BatchOptions) =>
        this.putMany(
          namespace,
          entries,
          { ...boundActor },
          {
            ...(options?.readSet === undefined
              ? {}
              : { readSet: options.readSet }),
          },
        ),
      list: (prefix?: string) => this.list(namespace, prefix),
      count: (prefix: string) => this.count(namespace, prefix),
      maxNumber: (prefix: string) => this.maxNumber(namespace, prefix),
      listRange: (options: RangeOptions) => this.listRange(namespace, options),
      history: (options: HistoryOptions) => this.history(namespace, options),
      events: (key?: string) => this.events(namespace, key),
    });
  }

  get(namespace: string, key: string): StateRecord | undefined {
    namespaceValid(namespace);
    keyValid(key);
    return body<StateRecord>(
      this.#db.get(
        "SELECT body FROM state_records WHERE namespace=? AND key=?",
        [namespace, key],
      ),
    );
  }
  list(namespace: string, prefix = ""): readonly StateRecord[] {
    namespaceValid(namespace);
    wellFormedText(prefix, "List prefix");
    const upper = upperBound(prefix);
    return this.#db
      .all(
        `SELECT body FROM state_records WHERE namespace=? AND key>=?${upper === undefined ? "" : " AND key<?"} ORDER BY key`,
        upper === undefined ? [namespace, prefix] : [namespace, prefix, upper],
      )
      .map((row) => body<StateRecord>(row)!)
      .filter((record) => record.key.startsWith(prefix));
  }
  count(namespace: string, prefix: string): number {
    return this.#aggregate(namespace, prefix, "COUNT(*)");
  }
  maxNumber(namespace: string, prefix: string): number {
    return this.#aggregate(
      namespace,
      prefix,
      "MAX(CASE WHEN key GLOB '*[0-9]' THEN CAST(substr(key, length(rtrim(key, '0123456789')) + 1) AS INTEGER) END)",
    );
  }
  #aggregate(namespace: string, prefix: string, expression: string): number {
    namespaceValid(namespace);
    wellFormedText(prefix, "Aggregate prefix");
    const upper = upperBound(prefix);
    return Number(
      this.#db.get(
        `SELECT ${expression} AS total FROM state_records WHERE namespace=? AND key>=?${upper === undefined ? "" : " AND key<?"}`,
        upper === undefined ? [namespace, prefix] : [namespace, prefix, upper],
      )?.total ?? 0,
    );
  }
  /** One bounded page of records from a key range, in key order or reverse. */
  listRange(namespace: string, options: RangeOptions): readonly StateRecord[] {
    namespaceValid(namespace);
    if (
      !Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 1000
    )
      invalid("Range limit must be an integer from 1 to 1000");
    const bounds: string[] = [];
    const params: string[] = [namespace];
    if (options.from !== undefined) {
      bounds.push("AND key>=?");
      params.push(options.from);
    }
    if (options.to !== undefined) {
      bounds.push("AND key<?");
      params.push(options.to);
    }
    return this.#db
      .all(
        `SELECT body FROM state_records WHERE namespace=? ${bounds.join(" ")} ORDER BY key ${options.descending === true ? "DESC" : "ASC"} LIMIT ${options.limit}`,
        params,
      )
      .map((row) => body<StateRecord>(row)!);
  }
  /** One bounded page of a key's events, newest first; the (namespace, key, sequence) index serves it. */
  history(namespace: string, options: HistoryOptions): readonly StateEvent[] {
    namespaceValid(namespace);
    keyValid(options.key);
    if (
      !Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 1000 ||
      (options.before !== undefined && !Number.isSafeInteger(options.before))
    )
      invalid("History limit must be an integer from 1 to 1000");
    return this.#db
      .all(
        `SELECT body FROM state_events WHERE namespace=? AND key=?${options.before === undefined ? "" : " AND json_extract(body,'$.revision')<?"} ORDER BY sequence DESC LIMIT ${options.limit}`,
        options.before === undefined
          ? [namespace, options.key]
          : [namespace, options.key, options.before],
      )
      .map((row) => body<StateEvent>(row)!);
  }
  events(namespace: string, key?: string): readonly StateEvent[] {
    namespaceValid(namespace);
    return this.#db
      .all(
        `SELECT body FROM state_events WHERE namespace=?${key === undefined ? "" : " AND key=?"} ORDER BY sequence`,
        key === undefined ? [namespace] : [namespace, key],
      )
      .map((row) => body<StateEvent>(row)!);
  }
  lease(namespace: string, subject: string): LeaseRecord | undefined {
    namespaceValid(namespace);
    keyValid(subject);
    return body<LeaseRecord>(
      this.#db.get(
        "SELECT body FROM state_leases WHERE namespace=? AND subject=?",
        [namespace, subject],
      ),
    );
  }
  #now(): number {
    const now = this.#clock.now();
    if (!Number.isFinite(now)) invalid("Invalid owner clock");
    return now;
  }
  #event(event: StateEvent): void {
    if (!validateStateEvent(event).ok) invalid("Invalid state event");
    this.#db.run(
      "INSERT INTO state_events(namespace,key,body) VALUES (?,?,?)",
      [event.namespace, event.key, json(event)],
    );
  }
  #held(namespace: string, fence: Fence, now: number): LeaseRecord {
    const current = this.lease(namespace, fence.subject);
    const decision = decideLease(current, {
      mode: "held",
      subject: fence.subject,
      holder: fence.holder,
      generation: fence.generation,
      nowMs: now,
    });
    if (!decision.ok) throw new ForgeFailure(decision.error);
    return current!;
  }
  #request<T>(
    namespace: string,
    requestId: string | undefined,
    input: unknown,
    work: () => T,
  ): T {
    const fingerprint = json(input);
    if (requestId === undefined) return work();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId))
      invalid("Invalid request ID");
    const prior = this.#db.get(
      "SELECT fingerprint,result FROM state_requests WHERE namespace=? AND request_id=?",
      [namespace, requestId],
    );
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new ForgeFailure({
          code: "INPUT_CONFLICT",
          message: "Request ID belongs to a different input",
          retry: "reconcile_first",
        });
      return JSON.parse(String(prior.result)) as T;
    }
    const result = work();
    this.#db.run(
      "INSERT INTO state_requests(namespace,request_id,fingerprint,result) VALUES (?,?,?,?)",
      [namespace, requestId, fingerprint, json(result)],
    );
    return result;
  }

  put(
    namespace: string,
    key: string,
    value: unknown,
    actor: Actor,
    options: WriteOptions,
  ): StateRecord {
    namespaceValid(namespace);
    keyValid(key);
    wellFormedText(key, "Key");
    if (
      !validateActor(actor).ok ||
      !Number.isSafeInteger(options.expectRevision) ||
      options.expectRevision < 0
    )
      invalid("Invalid actor or expected revision");
    const readSet = copyReadSet(options.readSet) ?? [];
    const stored = JSON.parse(json(value)) as unknown;
    return this.#db.transaction(() => {
      const now = this.#now();
      if (options.fence) this.#held(namespace, options.fence, now);
      return this.#request(
        namespace,
        options.requestId,
        {
          kind: "put",
          key,
          value: stored,
          actor,
          revision: options.expectRevision,
          fence: options.fence ?? null,
          ...(options.readSet === undefined ? {} : { readSet }),
        },
        () => {
          this.#readSetHolds(namespace, key, options.expectRevision, readSet);
          return this.#apply(
            namespace,
            key,
            stored,
            actor,
            now,
            options.requestId,
          );
        },
      );
    });
  }

  delete(
    namespace: string,
    key: string,
    actor: Actor,
    options: DeleteWriteOptions,
  ): StateEvent {
    namespaceValid(namespace);
    keyValid(key);
    if (
      !validateActor(actor).ok ||
      !Number.isSafeInteger(options.expectRevision) ||
      options.expectRevision <= 0
    )
      invalid("Deletion requires an actor and a positive expected revision");
    const readSet = copyReadSet(options.readSet) ?? [];
    return this.#db.transaction(() => {
      const now = this.#now();
      if (options.fence) this.#held(namespace, options.fence, now);
      this.#readSetHolds(namespace, key, options.expectRevision, readSet);
      const current = this.get(namespace, key)!;
      const event = deletionEvent(current, actor, new Date(now).toISOString());
      if (
        !validateStateEvent(event).ok ||
        !Number.isSafeInteger(event.revision)
      )
        invalid("Invalid deletion event");
      if (options.guard?.() === false)
        throw new ForgeFailure({
          code: "SERVICE_EXPIRED",
          message: "Deletion bound expired",
          retry: "never",
        });
      const removed = this.#db.run(
        "DELETE FROM state_records WHERE namespace=? AND key=? AND revision=?",
        [namespace, key, current.revision],
      );
      if (removed.changes !== 1)
        this.#stale(
          { key, expectRevision: options.expectRevision },
          this.get(namespace, key)?.revision ?? 0,
        );
      this.#event(event);
      return event;
    });
  }

  /**
   * Write several records in one transaction. Every guard a single put has applies to the whole
   * batch and is checked inside that transaction before anything is written: each entry's
   * expectRevision, the lease fence, and the read set (revisions of records the batch depends on,
   * which may be records it does not write). Any conflict leaves none of the records written.
   * A batch takes no request ID, so it leaves no replayable receipt and has no fingerprint; a
   * retried batch fails on its stale expectRevision rather than applying twice.
   */
  putMany(
    namespace: string,
    entries: readonly BatchEntry[],
    actor: Actor,
    options: BatchWriteOptions = {},
  ): readonly StateRecord[] {
    namespaceValid(namespace);
    if (!validateActor(actor).ok) invalid("Invalid actor");
    const readSet = copyReadSet(options.readSet) ?? [];
    const keys = new Set<string>();
    const prepared = entries.map((entry, index) => {
      keyValid(entry.key);
      wellFormedText(entry.key, `Batch entry ${index} key`);
      if (
        !Number.isSafeInteger(entry.expectRevision) ||
        entry.expectRevision < 0 ||
        keys.has(entry.key)
      )
        invalid("Invalid or repeated batch entry");
      keys.add(entry.key);
      return {
        key: entry.key,
        stored: JSON.parse(json(entry.value)) as unknown,
        expectRevision: entry.expectRevision,
      };
    });
    return this.#db.transaction(() => {
      const now = this.#now();
      if (options.fence) this.#held(namespace, options.fence, now);
      for (const entry of prepared) {
        const revision = this.get(namespace, entry.key)?.revision ?? 0;
        if (revision !== entry.expectRevision) this.#stale(entry, revision);
      }
      this.#readSetHolds(namespace, undefined, undefined, readSet);
      return prepared.map((entry) =>
        this.#apply(namespace, entry.key, entry.stored, actor, now, undefined),
      );
    });
  }

  /**
   * Write the next unused number under `prefix`. A floor record at `allocation:<prefix>` holds the
   * highest number ever allocated; the owner reads it, builds the record at floor + 1, and advances
   * the floor in one transaction, so a deleted number is never reused. A missing floor is first
   * computed from live keys and all matching history, inside this same lock.
   */
  putNext(
    namespace: string,
    prefix: string,
    build: (key: string, number: number) => NumberedBuild,
    actor: Actor,
    options: NumberedOptions = {},
  ): StateRecord {
    namespaceValid(namespace);
    const floorKey = `allocation:${prefix}`;
    keyValid(floorKey);
    wellFormedText(prefix, "Prefix");
    if (!validateActor(actor).ok) invalid("Invalid actor");
    return this.#db.transaction(() => {
      const now = this.#now();
      if (options.fence) this.#held(namespace, options.fence, now);
      const last =
        this.#floor(namespace, floorKey, prefix) ??
        this.#highest(namespace, prefix, floorKey, options.refuseMissing);
      const number = last + 1;
      const key = `${prefix}${number}`;
      if (!Number.isSafeInteger(number)) invalid("Numbers are exhausted");
      if (this.get(namespace, key))
        throw new ForgeFailure({
          code: "INPUT_CONFLICT",
          message: `Key ${key} is already in use`,
          retry: "reconcile_first",
        });
      const built = build(key, number);
      this.#readSetHolds(
        namespace,
        undefined,
        undefined,
        copyReadSet(built.readSet) ?? [],
      );
      const stored = JSON.parse(json(built.value)) as unknown;
      // The floor covers every allocated number, so the key is new and needs no history lookup.
      const record = this.#apply(
        namespace,
        key,
        stored,
        actor,
        now,
        undefined,
        true,
      );
      this.#apply(
        namespace,
        floorKey,
        { prefix, number },
        actor,
        now,
        undefined,
      );
      return record;
    });
  }

  /**
   * Restore only, after a verified replay: make the floor at `allocation:<prefix>` cover every number the
   * replay found. A present floor is kept exactly, and refused when malformed or below `found`. A missing
   * one is written at the highest number and after the revision the replay verified for that key, in the
   * restore's own transaction, then read back whole: the event by its known sequence (`events` is the
   * replay's event count) and the record with its indexed columns. The refusals are RestoreConsistencyFailure.
   * Returns whether it wrote a floor, so the caller advances `events` only for a pair that now exists.
   */
  seedNumberFloor(
    namespace: string,
    prefix: string,
    found: NumberedSummary,
    actor: Actor,
    events: number,
  ): boolean {
    namespaceValid(namespace);
    wellFormedText(prefix, "Prefix");
    const floorKey = `allocation:${prefix}`;
    keyValid(floorKey);
    if (!validateActor(actor).ok) invalid("Invalid actor");
    return this.#db.transaction(() => {
      const refuse = () =>
        new RestoreConsistencyFailure(
          "state_records",
          json([namespace, floorKey]),
        );
      let stored: number | undefined;
      try {
        stored = this.#floor(namespace, floorKey, prefix);
      } catch (error) {
        throw error instanceof ForgeFailure ? refuse() : error;
      }
      const needed = Math.max(found.highest, found.earlier);
      if (stored !== undefined) {
        if (stored < needed) throw refuse();
        return false;
      }
      const record = this.#apply(
        namespace,
        floorKey,
        { prefix, number: needed },
        actor,
        this.#now(),
        undefined,
        false,
        found.floorRevision,
      );
      const written = this.#db.get(
        "SELECT body, (SELECT MAX(sequence) FROM state_events) AS last FROM state_events WHERE sequence=?",
        [events + 1],
      );
      const saved = this.#db.get(
        "SELECT namespace,key,revision,body FROM state_records WHERE namespace=? AND key=?",
        [namespace, floorKey],
      );
      if (
        written === undefined ||
        Number(written.last) !== events + 1 ||
        json(body(written)) !== json(recordEvent(record)) ||
        saved === undefined ||
        saved.namespace !== namespace ||
        saved.key !== floorKey ||
        Number(saved.revision) !== record.revision ||
        String(saved.body) !== json(record)
      )
        throw new Error("The restored floor did not read back");
      return true;
    });
  }

  /**
   * The floor's number, or undefined only when its row is absent. A present row must be exactly the
   * record the owner wrote: bounded text, valid JSON, and a wrapper that matches its indexed namespace,
   * key and revision. Anything else, including a stored null, is refused rather than read as missing.
   */
  #floor(
    namespace: string,
    floorKey: string,
    prefix: string,
  ): number | undefined {
    const row = this.#db.get(
      "SELECT revision,body FROM state_records WHERE namespace=? AND key=?",
      [namespace, floorKey],
    );
    if (row === undefined) return undefined;
    const text = String(row.body);
    if (text.length > FLOOR_TEXT_MAX) invalid("Invalid allocation record");
    let stored: StateRecord;
    try {
      stored = JSON.parse(text) as StateRecord;
    } catch {
      return invalid("Invalid allocation record");
    }
    if (
      !validateStateRecord(stored).ok ||
      stored.namespace !== namespace ||
      stored.key !== floorKey ||
      stored.revision !== Number(row.revision)
    )
      invalid("Invalid allocation record");
    return floorNumber(stored.value, prefix);
  }

  /** The highest number under a prefix among live keys, all matching history and a deleted floor. */
  #highest(
    namespace: string,
    prefix: string,
    floorKey: string,
    refuse?: string,
  ): number {
    const upper = upperBound(prefix);
    const span = `namespace=? AND key>=?${upper === undefined ? "" : " AND key<?"}`;
    const bounds =
      upper === undefined ? [namespace, prefix] : [namespace, prefix, upper];
    const types = [
      `${namespace}:record.updated@1`,
      `${namespace}:record.deleted@1`,
    ];
    const typed = " AND json_extract(body,'$.type') IN (?,?)";
    if (refuse !== undefined) {
      // Two probes say whether any old state exists. LIMIT 1 bounds the rows returned, not the rows
      // examined, and this runs only while no floor exists, so it is a one-time cost bounded by the
      // project's existing event count.
      const old =
        this.#db.get(
          `SELECT 1 AS n FROM state_records WHERE ${span} LIMIT 1`,
          bounds,
        ) ??
        this.#db.get(
          `SELECT 1 AS n FROM state_events WHERE ${span}${typed} LIMIT 1`,
          [...bounds, ...types],
        );
      if (old)
        throw new ForgeFailure({
          code: "UNAVAILABLE",
          message: refuse,
          retry: "never",
        });
      return 0;
    }
    // Only the numeric suffix leaves SQLite; the longest, then largest, decimal string is the maximum.
    const top = (table: string, filter: string, extra: string[]) =>
      this.#db.get(
        `SELECT n FROM (SELECT substr(key,?) AS n FROM ${table} WHERE ${span}${filter}) WHERE n GLOB '[1-9]*' AND n NOT GLOB '*[^0-9]*' ORDER BY length(n) DESC, n DESC LIMIT 1`,
        [Array.from(prefix).length + 1, ...bounds, ...extra],
      )?.n;
    const earlier = this.#db.get(
      "SELECT MAX(json_extract(body,'$.data.number')) AS n FROM state_events WHERE namespace=? AND key=? AND json_extract(body,'$.type')=?",
      [namespace, floorKey, types[0]!],
    )?.n;
    return Math.max(
      ...[
        top("state_records", "", []),
        top("state_events", typed, types),
        earlier,
      ].map((value) => {
        const number = Number(value ?? 0);
        if (!Number.isSafeInteger(number))
          invalid("Allocation history holds an unsafe number");
        return number;
      }),
    );
  }

  #stale(
    entry: { readonly key: string; readonly expectRevision: number },
    revision: number,
  ): never {
    throw new ForgeFailure({
      code: "REVISION_CONFLICT",
      message: `Expected revision ${entry.expectRevision}; current revision is ${revision}`,
      retry: "reconcile_first",
      currentRevision: revision,
    });
  }

  /** The write's own expected revision, then every read-set revision; the first mismatch refuses. */
  #readSetHolds(
    namespace: string,
    key: string | undefined,
    expectRevision: number | undefined,
    readSet: NonNullable<WriteOptions["readSet"]>,
  ): void {
    if (key !== undefined && expectRevision !== undefined) {
      const revision = this.get(namespace, key)?.revision ?? 0;
      if (revision !== expectRevision)
        this.#stale({ key, expectRevision }, revision);
    }
    for (const read of readSet) {
      const currentRevision = this.get(namespace, read.key)?.revision ?? 0;
      if (currentRevision !== read.expectRevision)
        throw new ForgeFailure({
          code: "REVISION_CONFLICT",
          message: `Read-set key ${read.key}: expected revision ${read.expectRevision}; current revision is ${currentRevision}`,
          retry: "reconcile_first",
          currentRevision,
        });
    }
  }

  /** Write one record and its event; the caller has already checked every guard. */
  #apply(
    namespace: string,
    key: string,
    stored: unknown,
    actor: Actor,
    now: number,
    requestId: string | undefined,
    fresh = false,
    last?: number,
  ): StateRecord {
    const current = this.get(namespace, key);
    // An absent row can have history. Keep its last revision so recreation never revives an old
    // reader's compare-and-set token. The existing key index bounds this lookup to one key. A caller that
    // already holds the verified last revision (0 for a new key) passes it and skips the lookup.
    const revision =
      current?.revision ??
      last ??
      body<StateEvent>(
        fresh
          ? undefined
          : this.#db.get(
              "SELECT body FROM state_events WHERE namespace=? AND key=? AND json_extract(body,'$.type') IN (?,?) ORDER BY sequence DESC LIMIT 1",
              [
                namespace,
                key,
                `${namespace}:record.updated@1`,
                `${namespace}:record.deleted@1`,
              ],
            ),
      )?.revision ??
      0;
    const record: StateRecord = {
      namespace,
      key,
      revision: revision + 1,
      value: stored,
      updatedAt: new Date(now).toISOString(),
      updatedBy: actor,
    };
    if (
      !validateStateRecord(record).ok ||
      !Number.isSafeInteger(record.revision)
    )
      invalid("Invalid record");
    if (current) {
      const changed = this.#db.run(
        "UPDATE state_records SET revision=?,body=? WHERE namespace=? AND key=? AND revision=?",
        [record.revision, json(record), namespace, key, revision],
      );
      if (changed.changes !== 1)
        throw new ForgeFailure({
          code: "REVISION_CONFLICT",
          message: "Revision changed at commit",
          retry: "reconcile_first",
          currentRevision: this.get(namespace, key)?.revision ?? 0,
        });
    } else
      this.#db.run(
        "INSERT INTO state_records(namespace,key,revision,body) VALUES (?,?,?,?)",
        [namespace, key, record.revision, json(record)],
      );
    this.#event(recordEvent(record, requestId));
    return record;
  }

  acquire(
    namespace: string,
    subject: string,
    holder: LeaseHolder,
    durationMs: number,
    requestId: string,
    options?: AcquireOptions,
  ): LeaseRecord {
    namespaceValid(namespace);
    keyValid(subject);
    const accepted =
      options === undefined
        ? undefined
        : (JSON.parse(json(options)) as AcquireOptions);
    const readSet = copyReadSet(accepted?.readSet) ?? [];
    return this.#db.transaction(() => {
      const now = this.#now();
      const current = this.lease(namespace, subject);
      if (current?.subject !== subject)
        wellFormedText(subject, "Lease subject");
      // Historical acquisition replays cannot grant authority over a newer holder or revive expiry.
      const prior = this.#db.get(
        "SELECT result FROM state_requests WHERE namespace=? AND request_id=?",
        [namespace, requestId],
      );
      if (prior) {
        const replay = JSON.parse(String(prior.result)) as LeaseRecord;
        this.#held(
          namespace,
          { subject, holder, generation: replay.generation },
          now,
        );
      }
      return this.#request(
        namespace,
        requestId,
        {
          kind: "acquire",
          subject,
          holder,
          durationMs,
          ...acquisitionInput(accepted),
        },
        () => {
          this.#readSetHolds(namespace, undefined, undefined, readSet);
          const decision = decideLease(current, {
            mode: "acquire",
            subject,
            holder,
            nowMs: now,
          });
          if (!decision.ok) throw new ForgeFailure(decision.error);
          const entries = accepted?.entries ?? [];
          const keys = new Set<string>();
          for (const entry of entries) {
            keyValid(entry.key);
            if (
              !Number.isSafeInteger(entry.expectRevision) ||
              entry.expectRevision < 0 ||
              keys.has(entry.key)
            )
              invalid("Invalid or repeated acquisition entry");
            keys.add(entry.key);
            this.#readSetHolds(namespace, entry.key, entry.expectRevision, []);
          }
          const lease: LeaseRecord = {
            subject,
            holder,
            generation: decision.generation,
            expiresAt: this.#expiry(now, durationMs),
          };
          this.#saveLease(namespace, lease);
          this.#event(
            acquisitionEvent(
              namespace,
              lease,
              current,
              new Date(now).toISOString(),
              requestId,
              accepted,
            ),
          );
          for (const entry of entries)
            this.#apply(
              namespace,
              entry.key,
              entry.value,
              holder.actor,
              now,
              undefined,
            );
          return lease;
        },
      );
    });
  }
  #expiry(now: number, durationMs: number): string {
    if (
      !Number.isSafeInteger(durationMs) ||
      durationMs <= 0 ||
      !Number.isSafeInteger(now + durationMs)
    )
      invalid("Lease duration must produce a future finite expiry");
    if (Number.isNaN(new Date(now + durationMs).getTime()))
      invalid("Lease duration exceeds the date range");
    return new Date(now + durationMs).toISOString();
  }
  #saveLease(namespace: string, lease: LeaseRecord): void {
    if (
      !validateLeaseRecord(lease).ok ||
      !Number.isSafeInteger(lease.generation)
    )
      invalid("Invalid lease");
    this.#db.run(
      "INSERT INTO state_leases(namespace,subject,generation,body) VALUES (?,?,?,?) ON CONFLICT(namespace,subject) DO UPDATE SET generation=excluded.generation,body=excluded.body",
      [namespace, lease.subject, lease.generation, json(lease)],
    );
  }
  renew(namespace: string, fence: Fence, durationMs: number): LeaseRecord {
    return this.#changeLease(namespace, fence, durationMs);
  }
  release(namespace: string, fence: Fence): LeaseRecord {
    return this.#changeLease(namespace, fence);
  }
  #changeLease(
    namespace: string,
    fence: Fence,
    durationMs?: number,
  ): LeaseRecord {
    return this.#db.transaction(() => {
      const now = this.#now();
      const current = this.#held(namespace, fence, now);
      const at = new Date(now).toISOString();
      const event = changedLeaseEvent(
        namespace,
        current,
        fence.holder,
        at,
        durationMs === undefined ? undefined : this.#expiry(now, durationMs),
      );
      const lease = event.data as LeaseRecord;
      this.#saveLease(namespace, lease);
      this.#event(event);
      return lease;
    });
  }

  export(): Snapshot {
    let snapshot: Omit<Snapshot, "image"> | undefined;
    const image = this.#images().exportImage((db) => {
      snapshot = {
        // INTEGER PRIMARY KEY has no sqlite_sequence; retain the export boundary
        // separately so losing the final operation cannot shorten history silently.
        eventHighWaterMark: Number(
          db.get(
            "SELECT COALESCE(MAX(sequence),0) AS sequence FROM state_events",
          )?.sequence,
        ),
        domains: exportTables(db),
        format: "forge.state/1",
        records: db
          .all("SELECT body FROM state_records ORDER BY namespace,key")
          .map((row) => body<StateRecord>(row)!),
        events: db
          .all("SELECT body FROM state_events ORDER BY sequence")
          .map((row) => body<StateEvent>(row)!),
        leases: db
          .all(
            "SELECT namespace,body FROM state_leases ORDER BY namespace,subject",
          )
          .map((row) => ({
            namespace: String(row.namespace),
            lease: body<LeaseRecord>(row)!,
          })),
        requests: db
          .all(
            "SELECT namespace,request_id,fingerprint,result FROM state_requests ORDER BY namespace,request_id",
          )
          .map((row) => ({
            namespace: String(row.namespace),
            requestId: String(row.request_id),
            fingerprint: String(row.fingerprint),
            result: String(row.result),
          })),
      };
    });
    return { ...snapshot!, image: Buffer.from(image).toString("base64") };
  }
  /** Validate without mutating the candidate; only the adapter can replace database storage. */
  restore(
    snapshot: Snapshot,
    verifyRecovery?: () => void,
    pageSize: number = restorePageSize,
  ): void {
    if (
      snapshot.format !== "forge.state/1" ||
      typeof snapshot.image !== "string"
    )
      invalid("Unsupported snapshot");
    const image = Buffer.from(snapshot.image, "base64");
    if (image.toString("base64") !== snapshot.image)
      invalid("Invalid database image encoding");
    const imageStore = this.#images();
    const signature = (db: SqlDatabase): string =>
      JSON.stringify({
        migrations: db.all("SELECT id FROM state_migrations ORDER BY id"),
        domains: db.all(
          "SELECT namespace,table_name,reviewed_digest FROM state_domains ORDER BY table_name",
        ),
        schema: db.all(
          "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
        ),
        version: String(db.get("PRAGMA user_version")?.user_version),
      });
    const expected = signature(this.#db);
    const ledger =
      "SELECT sql FROM sqlite_master WHERE name='state_migrations'";
    const expectedLedger = this.#db.get(ledger)?.sql;
    let migrated = false;
    const empty = (): void => {
      for (const table of dataTables(this.#db))
        if (
          this.#db.get(`SELECT 1 FROM "${table.replaceAll('"', '""')}" LIMIT 1`)
        )
          invalid("Restore target must be empty");
    };
    empty();
    let eventHighWaterMark = snapshot.eventHighWaterMark;
    const validate = (candidate: SqlDatabase): void => {
      const newest = [...this.#knownMigrations].sort().at(-1);
      const version = candidate.get("PRAGMA user_version")?.user_version;
      if (Number(version) !== 0)
        invalid(`Snapshot schema:${String(version)}; newest known ${newest}`);
      if (!expectedLedger || candidate.get(ledger)?.sql !== expectedLedger)
        invalid("Unsupported snapshot migration ledger");
      const applied = candidate.all("SELECT id FROM state_migrations");
      for (const row of applied)
        if (!this.#knownMigrations.has(String(row.id)))
          invalid(`Snapshot version ${String(row.id)}; newest known ${newest}`);
      if (!applied.some((row) => row.id === baseline.id))
        invalid("Missing baseline");
      assertNoCheckpoint(candidate);
      assertRegistered(candidate);
      if (migrated && signature(candidate) !== expected)
        invalid("Snapshot schema or reviewed table registration differs");
      verifyEventDerivedState(
        candidate,
        eventHighWaterMark,
        pageSize,
        undefined,
        applied.some((row) => row.id === "004_state_checkpoint"),
      );
    };
    imageStore.restoreImage(
      image,
      validate,
      (candidate) => {
        new StateOwner(candidate, this.#clock).initialize(this.#domains);
        migrated = true;
        eventHighWaterMark += new StateOwner(
          candidate,
          this.#clock,
        ).releaseRestoredLeases(pageSize);
        validate(candidate);
      },
      () => {
        empty();
        if (signature(this.#db) !== expected)
          invalid("Restore target schema changed");
        verifyRecovery?.();
      },
    );
  }
  /** Preserve lease counters and history, but never revive authority from a backup. */
  releaseRestoredLeases(pageSize: number = restorePageSize): number {
    const at = new Date(this.#now()).toISOString();
    return this.#db.transaction(() => {
      let releasedCount = 0;
      // Only body changes below, never the (namespace, subject) keyset, so paging stays exact.
      for (const row of restoredRows(
        this.#db,
        "state_leases",
        "namespace,subject,body",
        ["namespace", "subject"],
        pageSize,
      )) {
        const lease = JSON.parse(String(row.body)) as LeaseRecord;
        if (!validateLeaseRecord(lease).ok) invalid("Invalid imported lease");
        if (
          !decideLease(lease, {
            mode: "held",
            subject: lease.subject,
            holder: lease.holder,
            generation: lease.generation,
            nowMs: Date.parse(at),
          }).ok
        )
          continue;
        const event = changedLeaseEvent(
          String(row.namespace),
          lease,
          lease.holder,
          at,
        );
        const released = event.data as LeaseRecord;
        this.#db.run(
          "UPDATE state_leases SET body=? WHERE namespace=? AND subject=?",
          [json(released), row.namespace!, row.subject!],
        );
        this.#db.run(
          "INSERT INTO state_events(namespace,key,body) VALUES (?,?,?)",
          [row.namespace!, row.subject!, json(event)],
        );
        releasedCount++;
      }
      return releasedCount;
    });
  }

  #images(): StateImageStore {
    const db = this.#db as Partial<StateImageStore>;
    if (!db.exportImage || !db.restoreImage)
      throw new Error("Store has no database image capability");
    return db as StateImageStore;
  }
}

/** A borrowed store remains usable after both success and failure of the callback. */
export async function withState<T>(
  handle: Handle<SqlDatabase>,
  clock: ClockPort,
  use: (owner: StateOwner) => T | Promise<T>,
): Promise<T> {
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = {
      ok: true,
      value: await use(new StateOwner(handle.value, clock)),
    };
  } catch (error) {
    outcome = { ok: false, error };
  }
  if (handle.ownership === "owned") {
    try {
      await handle.close();
    } catch (closeError) {
      if (!outcome.ok)
        throw new AggregateError(
          [outcome.error, closeError],
          "State callback and close failed",
          { cause: closeError },
        );
      throw closeError;
    }
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
