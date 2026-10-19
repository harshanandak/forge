import type { StateOwner, WriteOptions } from "../core/state/index.ts";
import type { BoundContext, LeaseRecord } from "../generated/types.ts";
import type {
  BatchEntry,
  BatchOptions,
  ExtendedStateClient,
  HistoryOptions,
  PutOptions,
  RangeOptions,
  StateClient,
} from "../ports/state.ts";
import { refuse } from "../core/trust/index.ts";

type ClientPutOptions = PutOptions &
  Pick<WriteOptions, "readSet"> & { readonly subject?: string };
type ClientBatchOptions = BatchOptions & { readonly subject?: string };

/** Assembly capability extension; the outside-block forge.state@1 contract is unchanged.
 * Held puts fence the supplied subject (the record key by default) in the owner's transaction.
 */
export interface LeaseStateClient extends ExtendedStateClient {
  now(): number;
  lease(subject: string): LeaseRecord | undefined;
  acquire(subject: string, durationMs: number): LeaseRecord;
  renew(subject: string, durationMs: number): LeaseRecord;
  release(subject: string): LeaseRecord;
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
    now: () => Date.now(),
    get: (key: string) => owner?.get(namespace, key),
    list: (prefix?: string) => owner?.list(namespace, prefix) ?? [],
    listRange: (range: RangeOptions) =>
      owner?.listRange(namespace, range) ?? [],
    history: (options: HistoryOptions) =>
      owner?.history(namespace, options) ?? [],
    events: (key?: string) => owner?.events(namespace, key) ?? [],
    lease: (subject: string) => owner?.lease(namespace, subject),
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
    acquire(subject: string, durationMs: number) {
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
      );
      acquired.set(subject, structuredClone(lease));
      return lease;
    },
    renew: (subject: string, durationMs: number) =>
      writable().renew(namespace, fence(subject), durationMs),
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
