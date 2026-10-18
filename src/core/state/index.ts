import { ForgeFailure } from "../../contract/failure.ts";
import { decideLease } from "../../contract/lease.ts";
import {
  validateActor,
  validateBlockId,
  validateLeaseRecord,
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
import {
  registerTables,
  exportTables,
  restoreTables,
  type DomainData,
} from "./domains.ts";

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
    if (Array.isArray(input)) result = input.map(walk);
    else {
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

export class StateOwner {
  readonly #db: SqlDatabase;
  readonly #clock: ClockPort;
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
      },
    );
  }

  client(namespace: string, actor: Actor): StateClient {
    namespaceValid(namespace);
    if (!validateActor(actor).ok) invalid("Invalid actor");
    const boundActor = JSON.parse(json(actor)) as Actor;
    return Object.freeze({
      get: (key: string) => this.get(namespace, key),
      put: (key: string, value: unknown, options: PutOptions) =>
        this.put(namespace, key, value, boundActor, options),
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
    // Deferred read transaction: no home creation, schema changes or write lock.
    this.#db.exec("BEGIN");
    try {
      const snapshot: Snapshot = {
        domains: exportTables(this.#db),
        format: "forge.state/1",
        records: this.#db
          .all("SELECT body FROM state_records ORDER BY namespace,key")
          .map((row) => body<StateRecord>(row)!),
        events: this.#db
          .all("SELECT body FROM state_events ORDER BY sequence")
          .map((row) => body<StateEvent>(row)!),
        leases: this.#db
          .all(
            "SELECT namespace,body FROM state_leases ORDER BY namespace,subject",
          )
          .map((row) => ({
            namespace: String(row.namespace),
            lease: body<LeaseRecord>(row)!,
          })),
        requests: this.#db
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
      this.#db.exec("COMMIT");
      return snapshot;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
  /** Restore only into an initialized empty target. Imported leases retain counters, never authority. */
  restore(snapshot: Snapshot, verifyRecovery?: () => void): void {
    if (snapshot.format !== "forge.state/1") invalid("Unsupported snapshot");
    this.#db.transaction(() => {
      if (
        this.#db.get(
          "SELECT 1 FROM state_records UNION ALL SELECT 1 FROM state_events UNION ALL SELECT 1 FROM state_leases UNION ALL SELECT 1 FROM state_requests LIMIT 1",
        )
      )
        invalid("Restore target must be empty");
      for (const record of snapshot.records) {
        if (
          !validateStateRecord(record).ok ||
          !Number.isSafeInteger(record.revision)
        )
          invalid("Invalid imported record");
        this.#db.run(
          "INSERT INTO state_records(namespace,key,revision,body) VALUES (?,?,?,?)",
          [record.namespace, record.key, record.revision, json(record)],
        );
      }
      for (const event of snapshot.events) this.#event(event);
      for (const request of snapshot.requests) {
        namespaceValid(request.namespace);
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.requestId))
          invalid("Invalid imported request ID");
        json(JSON.parse(request.fingerprint));
        json(JSON.parse(request.result));
        this.#db.run(
          "INSERT INTO state_requests(namespace,request_id,fingerprint,result) VALUES (?,?,?,?)",
          [
            request.namespace,
            request.requestId,
            request.fingerprint,
            request.result,
          ],
        );
      }
      const at = new Date(this.#now()).toISOString();
      restoreTables(this.#db, snapshot.domains);
      for (const entry of snapshot.leases) {
        namespaceValid(entry.namespace);
        this.#saveLease(entry.namespace, { ...entry.lease, releasedAt: at });
      }
      verifyRecovery?.();
    });
  }
}

/** A borrowed store remains usable after both success and failure of the callback. */
export async function withState<T>(
  handle: Handle<SqlDatabase>,
  clock: ClockPort,
  use: (owner: StateOwner) => T | Promise<T>,
): Promise<T> {
  try {
    return await use(new StateOwner(handle.value, clock));
  } finally {
    if (handle.ownership === "owned") await handle.close();
  }
}
