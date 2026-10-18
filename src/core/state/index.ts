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
import type { StateClient, PutOptions } from "../../ports/state.ts";
import type { SqlDatabase, SqlRow } from "../../ports/store.ts";
import type { Handle } from "../../ports/lifetime.ts";
import { baseline, migrate, type Migration } from "./migrations.ts";
import { registerTables, exportTables, type DomainData } from "./domains.ts";

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
function namespaceValid(namespace: string): void {
  if (!validateBlockId(namespace).ok) invalid("Invalid namespace");
}

function validateReceipt(row: SqlRow, events: readonly StateEvent[]): void {
  let input: Record<string, unknown>;
  let result: unknown;
  try {
    input = JSON.parse(String(row.fingerprint)) as Record<string, unknown>;
    result = JSON.parse(String(row.result)) as unknown;
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
  const matches = events.filter(
    (event) =>
      event.namespace === row.namespace && event.requestId === row.request_id,
  );
  if (matches.length !== 1)
    invalid("Imported request needs exactly one matching event");
  const event = matches[0]!;
  if (input.kind === "put") {
    const record = result as StateRecord;
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
          revision: event.revision - 1,
          fence: input.fence,
        })
    )
      invalid("Imported put receipt does not match its operation");
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
      let lease: LeaseRecord | undefined;
      for (const prior of events) {
        if (prior === event) break;
        if (prior.namespace !== event.namespace || prior.key !== fence.subject)
          continue;
        if (
          prior.type === `${event.namespace}:lease.acquired@1` ||
          prior.type === `${event.namespace}:lease.reacquired@1`
        )
          lease = (prior.data as { lease?: LeaseRecord } | null)?.lease;
        else if (
          prior.type === `${event.namespace}:lease.renewed@1` ||
          prior.type === `${event.namespace}:lease.released@1`
        )
          lease = prior.data as LeaseRecord;
        else continue;
        if (!validateLeaseRecord(lease).ok)
          invalid("Invalid imported request lease history");
      }
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
        })
    )
      invalid("Imported acquisition receipt does not match its operation");
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

/** Reproduce all event-derived tables before accepting an image. Domain tables and
 * registration/migration ledgers have no event provenance; schema and FK checks cover them. */
function verifyEventDerivedState(
  candidate: SqlDatabase,
  highWaterMark: number,
): void {
  if (!Number.isSafeInteger(highWaterMark) || highWaterMark < 0)
    throw new RestoreConsistencyFailure("state_events", "high-water mark");
  const records = new Map<string, StateRecord>();
  const leases = new Map<string, LeaseRecord>();
  const requests = new Map<string, StateEvent>();
  const events: StateEvent[] = [];
  const key = (namespace: string, name: string): string =>
    json([namespace, name]);
  const reject = (table: string, name: string): never => {
    throw new RestoreConsistencyFailure(table, name);
  };
  const inspect = (table: string, name: string, check: () => void): void => {
    try {
      check();
    } catch (error) {
      if (error instanceof RestoreConsistencyFailure) throw error;
      reject(table, name);
    }
  };
  let sequence = 0;
  for (const row of candidate.all(
    "SELECT sequence,namespace,key,body FROM state_events ORDER BY sequence",
  )) {
    const id = key(String(row.namespace), String(row.key));
    sequence++;
    if (row.sequence !== sequence && row.sequence !== BigInt(sequence))
      reject("state_events", id);
    inspect("state_events", id, () => {
      const event = JSON.parse(String(row.body)) as StateEvent;
      if (
        !validateStateEvent(event).ok ||
        !Number.isSafeInteger(event.revision) ||
        event.namespace !== row.namespace ||
        event.key !== row.key
      )
        reject("state_events", id);
      events.push(event);
      if (event.requestId !== undefined) {
        const request = key(event.namespace, event.requestId);
        if (requests.has(request)) reject("state_requests", request);
        requests.set(request, event);
      }
      if (event.type === `${event.namespace}:record.updated@1`) {
        if (event.revision !== (records.get(id)?.revision ?? 0) + 1)
          reject("state_records", id);
        records.set(id, {
          namespace: event.namespace,
          key: event.key,
          revision: event.revision,
          value: event.data,
          updatedAt: event.at,
          updatedBy: event.actor,
        });
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
          };
          lease = data.lease;
          if (
            json(data.previous) !== json(prior ?? null) ||
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
              json(lease) !== json({ ...prior, expiresAt: lease.expiresAt }) ||
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
            json(lease) !== json({ ...prior, releasedAt: event.at })
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
  for (const row of candidate.all(
    "SELECT namespace,key,revision,body FROM state_records",
  )) {
    const id = key(String(row.namespace), String(row.key));
    inspect("state_records", id, () => {
      const record = JSON.parse(String(row.body)) as StateRecord;
      if (
        !validateStateRecord(record).ok ||
        !records.has(id) ||
        json(record) !== json(records.get(id)) ||
        record.revision !== Number(row.revision)
      )
        reject("state_records", id);
      records.delete(id);
    });
  }
  if (records.size) reject("state_records", records.keys().next().value!);
  for (const row of candidate.all(
    "SELECT namespace,subject,generation,body FROM state_leases",
  )) {
    const id = key(String(row.namespace), String(row.subject));
    inspect("state_leases", id, () => {
      const lease = JSON.parse(String(row.body)) as LeaseRecord;
      if (
        !leases.has(id) ||
        json(lease) !== json(leases.get(id)) ||
        lease.generation !== Number(row.generation)
      )
        reject("state_leases", id);
      leases.delete(id);
    });
  }
  if (leases.size) reject("state_leases", leases.keys().next().value!);
  for (const row of candidate.all(
    "SELECT namespace,request_id,fingerprint,result FROM state_requests",
  )) {
    const id = key(String(row.namespace), String(row.request_id));
    inspect("state_requests", id, () => {
      namespaceValid(String(row.namespace));
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(String(row.request_id)))
        reject("state_requests", id);
      validateReceipt(row, events);
      requests.delete(id);
    });
  }
  if (requests.size) reject("state_requests", requests.keys().next().value!);
}

// Only these ledgers contain setup metadata that restore may replace in a nonempty store.
const metadataTables = new Set(["state_migrations", "state_domains"]);
const stateDataTables = new Set([
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

export class StateOwner {
  readonly #db: SqlDatabase;
  readonly #clock: ClockPort;
  #knownMigrations = new Set([baseline.id]);
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
      [baseline, ...domains.flatMap((domain) => domain.migrations)],
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
        const registered = new Set(
          this.#db
            .all("SELECT table_name FROM state_domains")
            .map((row) => String(row.table_name)),
        );
        for (const table of dataTables(this.#db))
          if (!stateDataTables.has(table) && !registered.has(table))
            invalid(`Unregistered user table: ${table}`);
      },
    );
    this.#knownMigrations = new Set([
      baseline.id,
      ...domains.flatMap((domain) =>
        domain.migrations.map((migration) => migration.id),
      ),
    ]);
  }

  client(namespace: string, actor: Actor): StateClient {
    namespaceValid(namespace);
    if (!validateActor(actor).ok) invalid("Invalid actor");
    const boundActor = Object.freeze(JSON.parse(json(actor)) as Actor);
    return Object.freeze({
      get: (key: string) => this.get(namespace, key),
      put: (key: string, value: unknown, options: PutOptions) =>
        this.put(namespace, key, value, { ...boundActor }, options),
      list: (prefix?: string) => this.list(namespace, prefix),
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
    return this.#db
      .all("SELECT body FROM state_records WHERE namespace=? ORDER BY key", [
        namespace,
      ])
      .map((row) => body<StateRecord>(row)!)
      .filter((record) => record.key.startsWith(prefix));
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
    if (
      !validateActor(actor).ok ||
      !Number.isSafeInteger(options.expectRevision) ||
      options.expectRevision < 0
    )
      invalid("Invalid actor or expected revision");
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
        },
        () => {
          const current = this.get(namespace, key);
          const revision = current?.revision ?? 0;
          if (revision !== options.expectRevision)
            throw new ForgeFailure({
              code: "REVISION_CONFLICT",
              message: `Expected revision ${options.expectRevision}; current revision is ${revision}`,
              retry: "reconcile_first",
              currentRevision: revision,
            });
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
          this.#event({
            type: `${namespace}:record.updated@1`,
            namespace,
            key,
            revision: record.revision,
            at: record.updatedAt,
            actor,
            ...(options.requestId === undefined
              ? {}
              : { requestId: options.requestId }),
            data: stored,
          });
          return record;
        },
      );
    });
  }

  acquire(
    namespace: string,
    subject: string,
    holder: LeaseHolder,
    durationMs: number,
    requestId: string,
  ): LeaseRecord {
    namespaceValid(namespace);
    keyValid(subject);
    return this.#db.transaction(() => {
      const now = this.#now();
      const current = this.lease(namespace, subject);
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
        { kind: "acquire", subject, holder, durationMs },
        () => {
          const decision = decideLease(current, {
            mode: "acquire",
            subject,
            holder,
            nowMs: now,
          });
          if (!decision.ok) throw new ForgeFailure(decision.error);
          const lease: LeaseRecord = {
            subject,
            holder,
            generation: decision.generation,
            expiresAt: this.#expiry(now, durationMs),
          };
          this.#saveLease(namespace, lease);
          this.#event({
            type: `${namespace}:lease.${decision.kind === "acquired" && decision.reacquired ? "reacquired" : "acquired"}@1`,
            namespace,
            key: subject,
            revision: lease.generation,
            at: new Date(now).toISOString(),
            actor: holder.actor,
            requestId,
            data: { lease, previous: current ?? null },
          });
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
      const lease =
        durationMs === undefined
          ? { ...current, releasedAt: at }
          : { ...current, expiresAt: this.#expiry(now, durationMs) };
      this.#saveLease(namespace, lease);
      this.#event({
        type: `${namespace}:lease.${durationMs === undefined ? "released" : "renewed"}@1`,
        namespace,
        key: fence.subject,
        revision: lease.generation,
        at,
        actor: fence.holder.actor,
        data: lease,
      });
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
  restore(snapshot: Snapshot, verifyRecovery?: () => void): void {
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
    const empty = (): void => {
      for (const table of dataTables(this.#db))
        if (
          this.#db.get(`SELECT 1 FROM "${table.replaceAll('"', '""')}" LIMIT 1`)
        )
          invalid("Restore target must be empty");
    };
    empty();
    let eventHighWaterMark = snapshot.eventHighWaterMark;
    imageStore.restoreImage(
      image,
      (candidate) => {
        if (signature(candidate) !== expected)
          invalid(
            "Snapshot needs the same schema, baseline version and reviewed table registration",
          );
        if (
          !candidate.get("SELECT id FROM state_migrations WHERE id=?", [
            baseline.id,
          ]) ||
          candidate
            .all("SELECT id FROM state_migrations")
            .some((row) => !this.#knownMigrations.has(String(row.id))) ||
          Number(candidate.get("PRAGMA user_version")?.user_version) !== 0
        )
          invalid("Unsupported baseline or newer schema version");
        verifyEventDerivedState(candidate, eventHighWaterMark);
      },
      (candidate) => {
        // Preserve lease counters and receipts, but never revive authority from a backup.
        const at = new Date(this.#now()).toISOString();
        candidate.transaction(() => {
          for (const row of candidate.all(
            "SELECT namespace,subject,body FROM state_leases",
          )) {
            const lease = JSON.parse(String(row.body)) as LeaseRecord;
            if (!validateLeaseRecord(lease).ok)
              invalid("Invalid imported lease");
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
            const released = { ...lease, releasedAt: at };
            candidate.run(
              "UPDATE state_leases SET body=? WHERE namespace=? AND subject=?",
              [json(released), row.namespace!, row.subject!],
            );
            candidate.run(
              "INSERT INTO state_events(namespace,key,body) VALUES (?,?,?)",
              [
                row.namespace!,
                row.subject!,
                json({
                  type: `${String(row.namespace)}:lease.released@1`,
                  namespace: row.namespace,
                  key: lease.subject,
                  revision: lease.generation,
                  at,
                  actor: lease.holder.actor,
                  data: released,
                }),
              ],
            );
            eventHighWaterMark++;
          }
        });
      },
      () => {
        empty();
        if (signature(this.#db) !== expected)
          invalid("Restore target schema changed");
        verifyRecovery?.();
      },
    );
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
