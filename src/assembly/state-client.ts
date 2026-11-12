import type {
  AcquireOptions,
  NumberedBuild,
  StateOwner,
  WriteOptions,
} from "../core/state/index.ts";
import type {
  BoundContext,
  LeaseHolder,
  LeaseRecord,
  StateRecord,
} from "../generated/types.ts";
import type {
  BatchEntry,
  BatchOptions,
  DeleteOptions,
  DeletableStateClient,
  ExtendedStateClient,
  HistoryOptions,
  PutOptions,
  RangeOptions,
  StateClient,
} from "../ports/state.ts";
import { refuse } from "../core/trust/index.ts";
import { jsonEqual } from "../contract/schema.ts";

type ClientPutOptions = PutOptions &
  Pick<WriteOptions, "readSet"> & { readonly subject?: string };
type ClientBatchOptions = BatchOptions & { readonly subject?: string };
type ClientDeleteOptions = DeleteOptions & {
  readonly subject?: string;
  readonly guard?: () => boolean;
};
type LandingCommentInput = {
  readonly id: string;
  readonly pr: number;
  readonly receipt: string;
  readonly generation: number;
};

/** Assembly capability extension; the outside-block forge.state@1 contract is unchanged.
 * Held puts fence the supplied subject (the record key by default) in the owner's transaction.
 */
export interface LeaseStateClient extends DeletableStateClient {
  delete(
    key: string,
    options: ClientDeleteOptions,
  ): ReturnType<DeletableStateClient["delete"]>;
  holder(): LeaseHolder;
  now(): number;
  lease(subject: string): LeaseRecord | undefined;
  acquire(
    subject: string,
    durationMs: number,
    options?: AcquireOptions,
  ): LeaseRecord;
  renew(subject: string, durationMs: number): LeaseRecord;
  release(subject: string): LeaseRecord;
  releaseOwn(subject: string): LeaseRecord;
  withOwnLease(subject: string): LeaseStateClient;
  /** Write the next unused number under a key prefix; the owner keeps the floor, never the caller. */
  putNext(
    prefix: string,
    build: (key: string, number: number) => NumberedBuild,
    options?: { readonly subject?: string },
  ): StateRecord;
  /** Completes only the note already authorized by a fenced work landing. */
  appendLandingComment(input: LandingCommentInput): StateRecord;
  put(
    key: string,
    value: unknown,
    options: ClientPutOptions,
  ): ReturnType<StateClient["put"]>;
  /** Under a held lease a batch names the subject it is fenced to; there is no default. */
  putMany(
    entries: readonly BatchEntry[],
    options?: ClientBatchOptions,
  ): ReturnType<ExtendedStateClient["putMany"]>;
}

export function createStateClient(options: {
  readonly owner: StateOwner | undefined;
  readonly namespace: string;
  readonly context: BoundContext;
  readonly write: boolean;
  readonly requestId: string;
}): LeaseStateClient {
  const { owner, namespace, context, write, requestId } = options;
  const acquired = new Map<string, LeaseRecord>();
  function writable(): StateOwner {
    if (!write)
      refuse(
        "GRANT_REQUIRED",
        "Operation did not declare its record write effect",
      );
    if (context.variant === "stateless")
      refuse(
        "CONTEXT_MISSING",
        "State writes require an actor and project or device context",
      );
    if (!owner) refuse("PROVIDER_MISSING", "Writable state is not open");
    return owner;
  }
  function fence(subject: string) {
    if (context.variant !== "leased" || context.leaseMode !== "held")
      refuse("CONTEXT_MISSING", "This write requires a held lease context");
    return {
      subject,
      holder: { actor: context.actor, session: context.session },
      generation: context.leaseGeneration,
    };
  }
  return Object.freeze({
    holder() {
      if (context.variant !== "leased")
        refuse("CONTEXT_MISSING", "Missing lease holder");
      return structuredClone({
        actor: context.actor,
        session: context.session,
      });
    },
    now: () => Date.now(),
    get: (key: string) => owner?.get(namespace, key),
    list: (prefix?: string) => owner?.list(namespace, prefix) ?? [],
    count: (prefix: string) => owner?.count(namespace, prefix) ?? 0,
    maxNumber: (prefix: string) => owner?.maxNumber(namespace, prefix) ?? 0,
    listRange: (range: RangeOptions) =>
      owner?.listRange(namespace, range) ?? [],
    history: (options: HistoryOptions) =>
      owner?.history(namespace, options) ?? [],
    events: (key?: string) => owner?.events(namespace, key) ?? [],
    lease: (subject: string) => owner?.lease(namespace, subject),
    appendLandingComment(input: LandingCommentInput) {
      const state = writable();
      const held = fence(`issue:${input.id}`);
      const authorityKey = `landing:${input.id}:${input.pr}`;
      const authority = state.get(namespace, authorityKey);
      const landing = authority?.value as
        | {
            id?: string;
            pr?: number;
            receipt?: string;
            generation?: number;
            note?: string;
          }
        | undefined;
      const issue = state.get(namespace, held.subject);
      const value = issue?.value as
        { status?: string; receipt?: string } | undefined;
      const lease = state.lease(namespace, held.subject);
      if (
        !authority ||
        !issue ||
        !landing ||
        landing.id !== input.id ||
        landing.pr !== input.pr ||
        landing.receipt !== input.receipt ||
        landing.generation !== input.generation ||
        held.generation !== input.generation ||
        lease?.generation !== input.generation ||
        value?.status !== "closed" ||
        value.receipt !== input.receipt ||
        typeof landing.note !== "string" ||
        !landing.note
      )
        refuse(
          "LEASE_REQUIRED",
          "No matching accepted landing authorizes this comment",
        );
      const prefix = `comment:${input.id}:`;
      const comments = state.list(namespace, prefix);
      const matching = comments.find((row) => {
        const body = (row.value as { body?: string }).body;
        return (
          body === landing.note || body?.startsWith(landing.note + "\nChecks: ")
        );
      });
      if (matching) return matching;
      const key = prefix + (comments.length + 1);
      // Only this accepted note may cross the expired lease boundary, never an issue write.
      const written = state.put(
        namespace,
        key,
        { id: input.id, body: landing.note },
        held.holder.actor,
        {
          expectRevision: 0,
          readSet: [
            { key: authorityKey, expectRevision: authority.revision },
            { key: held.subject, expectRevision: issue.revision },
          ],
        },
      );
      if (!jsonEqual(state.get(namespace, key), written))
        refuse(
          "INTERNAL",
          "Accepted landing comment did not match its readback",
        );
      return written;
    },
    delete(key: string, options: ClientDeleteOptions) {
      const state = writable();
      if (context.variant === "stateless")
        refuse("CONTEXT_MISSING", "Missing actor");
      if (context.variant === "leased" && context.leaseMode !== "held")
        refuse("CONTEXT_MISSING", "Acquisition cannot mutate records");
      return state.delete(namespace, key, context.actor, {
        expectRevision: options.expectRevision,
        ...(options.guard === undefined ? {} : { guard: options.guard }),
        ...(options.readSet === undefined
          ? {}
          : { readSet: structuredClone(options.readSet) }),
        ...(context.variant === "leased"
          ? { fence: fence(options.subject ?? key) }
          : {}),
      });
    },
    put(key: string, value: unknown, put: ClientPutOptions) {
      const state = writable();
      if (context.variant === "stateless")
        refuse("CONTEXT_MISSING", "Missing actor");
      if (context.variant === "leased" && context.leaseMode !== "held")
        refuse("CONTEXT_MISSING", "Acquisition cannot mutate records");
      return state.put(namespace, key, structuredClone(value), context.actor, {
        expectRevision: put.expectRevision,
        ...(put.readSet === undefined
          ? {}
          : { readSet: structuredClone(put.readSet) }),
        ...(context.variant === "leased"
          ? { fence: fence(put.subject ?? key) }
          : {}),
      });
    },
    putNext(
      prefix: string,
      build: (key: string, number: number) => NumberedBuild,
      next?: { readonly subject?: string },
    ) {
      const state = writable();
      if (context.variant === "stateless")
        refuse("CONTEXT_MISSING", "Missing actor");
      if (context.variant === "leased" && context.leaseMode !== "held")
        refuse("CONTEXT_MISSING", "Acquisition cannot mutate records");
      if (context.variant === "leased" && next?.subject === undefined)
        refuse(
          "CONTEXT_MISSING",
          "A numbered write under a lease names its subject",
        );
      // The builder may run in an isolate; clone what it returns, as put does for its value.
      const cloned = (key: string, number: number) =>
        structuredClone(build(key, number));
      return state.putNext(namespace, prefix, cloned, context.actor, {
        ...(context.variant === "leased" && next?.subject !== undefined
          ? { fence: fence(next.subject) }
          : {}),
      });
    },
    putMany(entries: readonly BatchEntry[], batch?: ClientBatchOptions) {
      const state = writable();
      if (context.variant === "stateless")
        refuse("CONTEXT_MISSING", "Missing actor");
      if (context.variant === "leased" && context.leaseMode !== "held")
        refuse("CONTEXT_MISSING", "Acquisition cannot mutate records");
      if (context.variant === "leased" && batch?.subject === undefined)
        refuse(
          "CONTEXT_MISSING",
          "A batch write under a lease names the subject it is fenced to",
        );
      return state.putMany(
        namespace,
        entries.map((entry) => ({
          ...entry,
          value: structuredClone(entry.value),
        })),
        context.actor,
        {
          ...(batch?.readSet === undefined
            ? {}
            : { readSet: structuredClone(batch.readSet) }),
          ...(context.variant === "leased" && batch?.subject !== undefined
            ? { fence: fence(batch.subject) }
            : {}),
        },
      );
    },
    acquire(subject: string, durationMs: number, options?: AcquireOptions) {
      const state = writable();
      if (context.variant !== "leased" || context.leaseMode !== "acquire")
        refuse(
          "CONTEXT_MISSING",
          "Acquisition requires an acquire lease context",
        );
      const lease = state.acquire(
        namespace,
        subject,
        { actor: context.actor, session: context.session },
        durationMs,
        requestId,
        options,
      );
      acquired.set(subject, structuredClone(lease));
      return lease;
    },
    renew: (subject: string, durationMs: number) =>
      writable().renew(namespace, fence(subject), durationMs),
    withOwnLease(subject: string): LeaseStateClient {
      if (context.variant !== "leased")
        refuse("CONTEXT_MISSING", "Missing lease holder");
      const lease = writable().lease(namespace, subject);
      if (!lease) refuse("LEASE_NOT_HELD", "No lease on this subject");
      return Object.freeze({
        ...createStateClient({
          ...options,
          context: {
            ...context,
            leaseMode: "held",
            leaseGeneration: lease.generation,
          },
        }),
        now: this.now,
      });
    },
    releaseOwn(subject: string) {
      const lease = writable().lease(namespace, subject);
      if (!lease) refuse("LEASE_NOT_HELD", "No lease on this subject");
      return writable().release(namespace, {
        subject,
        holder: this.holder(),
        generation: lease.generation,
      });
    },
    release(subject: string) {
      const state = writable();
      const rollback =
        context.variant === "leased" && context.leaseMode === "acquire"
          ? acquired.get(subject)
          : undefined;
      // Acquisition may revoke only a grant returned to this invocation, never an ambient lease.
      const held = rollback
        ? { subject, holder: rollback.holder, generation: rollback.generation }
        : fence(subject);
      return state.release(namespace, held);
    },
  });
}
