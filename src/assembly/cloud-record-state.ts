import { ForgeFailure } from "../contract/failure.ts";
import { digestValue } from "../core/config/pointer.ts";
import { json } from "../core/state/index.ts";
import type { AmbientContext, StateEvent } from "../generated/types.ts";
import type { AsyncStateClient } from "../ports/state.ts";
import type {
  StateCommitRequest,
  StateQuery,
  StateReadResult,
  StateReadRequest,
} from "../ports/state-protocol.ts";
import {
  createCloudRecordClient,
  CloudRecordRefusal,
  type CloudRecordOptions,
} from "./cloud-state-client.ts";

/** Serialized plans over the checked record client. Assembly does not select this provider yet. */
export function createCloudRecordState(
  options: CloudRecordOptions & {
    namespace: string;
    context: AmbientContext;
    operation: string;
    requestId: string;
    write: boolean;
    deadline: number;
  },
): AsyncStateClient {
  const { namespace, context, operation } = options;
  const signal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    AbortSignal.timeout(Math.max(1, options.deadline - options.now())),
  ]);
  const client = createCloudRecordClient({ ...options, signal });
  const capability = { version: 1 as const, namespace, context, operation };
  let plan: Pick<StateReadRequest, "policyRevision" | "readVersion"> = {
    policyRevision: "discover",
  };
  const dependencies = new Map<string, number>();
  let pending:
    { bytes: string; intent: string; principal?: string } | undefined;
  let sequence = 0,
    tail: Promise<unknown> = Promise.resolve();
  const fail = (code: string) =>
    new ForgeFailure({
      code,
      message: `Cloud state refused (${code}).`,
      retry: code === "UNAVAILABLE" ? "reconcile_first" : "never",
    });
  const reset = () => {
    plan = { policyRevision: "discover" };
    dependencies.clear();
  };
  const pin = ({
    policyRevision,
    readVersion,
  }: Pick<StateReadResult, "policyRevision" | "readVersion">) => {
    plan = { policyRevision, readVersion };
  };
  function active() {
    if (options.signal?.aborted) throw fail("INVOCATION_CANCELLED");
    if (options.now() >= options.deadline || signal.aborted)
      throw fail("INVOCATION_TIMEOUT");
  }
  function conflict(error: unknown): never {
    if (
      error instanceof CloudRecordRefusal &&
      ["REVISION_CONFLICT", "INPUT_CONFLICT"].includes(error.error.code)
    ) {
      reset();
    }
    throw error;
  }
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const result = tail.then(active).then(run);
    tail = result.catch(() => {});
    return result;
  };
  async function read<K extends StateQuery["kind"]>(
    query: StateQuery & { kind: K },
  ): Promise<StateReadResult["result"] & { kind: K }> {
    active();
    if (pending) throw fail("UNAVAILABLE");
    const answer = await client
      .read({
        ...capability,
        kind: "read",
        ...plan,
        query,
      })
      .catch(conflict);
    const result = answer.result;
    if (result.kind !== query.kind) throw fail("UNAVAILABLE");
    pin(answer);
    if (result.kind === "get" && "key" in query)
      dependencies.set(query.key, result.record?.revision ?? 0);
    return result as StateReadResult["result"] & { kind: K };
  }
  async function commit(intent: string) {
    if (!options.write) throw fail("GRANT_REQUIRED");
    const replay = pending !== undefined;
    if (pending && pending.intent !== intent) throw fail("UNAVAILABLE");
    if (!pending) {
      const { entries, readSet: explicit } = JSON.parse(intent) as Pick<
        StateCommitRequest,
        "entries" | "readSet"
      >;
      if (!plan.readVersion) await read({ kind: "count", prefix: "" });
      const reads = new Map(dependencies);
      for (const { key, expectRevision } of explicit) {
        if (reads.has(key) && reads.get(key) !== expectRevision)
          return conflict(fail("REVISION_CONFLICT"));
        reads.set(key, expectRevision);
      }
      const readSet = [...reads]
        .map(([key, expectRevision]) => ({ key, expectRevision }))
        .map((entry) => ({
          ...entry,
          namespace,
          readVersion: plan.readVersion!,
        }));
      const requestId = digestValue([options.requestId, namespace, ++sequence]);
      pending = {
        intent,
        bytes: JSON.stringify({
          ...capability,
          kind: "commit",
          ...plan,
          requestId,
          input: null,
          readSet,
          entries,
        }),
      };
    }
    try {
      active();
      const answer = await client.commit(
        JSON.parse(pending.bytes) as StateCommitRequest,
        (id) => {
          if (pending!.principal && pending!.principal !== id)
            throw fail("UNAVAILABLE");
          pending!.principal = id;
        },
      );
      pending = undefined;
      dependencies.clear();
      // A replayed receipt proves acceptance, not the current namespace version.
      if (replay) reset();
      else pin(answer);
      return answer.records;
    } catch (error) {
      if (!replay && error instanceof CloudRecordRefusal) {
        pending = undefined;
        return conflict(error);
      }
      throw error;
    }
  }
  const putMany: AsyncStateClient["putMany"] = async (entries, batch) => {
    const intent = json({ entries, readSet: batch?.readSet ?? [] });
    return serial(() => commit(intent));
  };
  return Object.freeze({
    get: (key) =>
      serial(
        async () => (await read({ kind: "get", key })).record ?? undefined,
      ),
    put: (key, value, put) =>
      putMany([{ key, value, ...put }]).then((records) => records[0]!),
    putMany,
    range: (range) =>
      serial(async () => (await read({ kind: "range", ...range })).records),
    history: (history) =>
      serial(async () => {
        const events: StateEvent[] = [];
        let before: number | undefined;
        do {
          const r = await read({
            kind: "history",
            key: history.key,
            limit: history.limit,
            ...(before === undefined ? {} : { before }),
          });
          events.push(
            ...r.events.filter(
              (event) =>
                history.before === undefined || event.revision < history.before,
            ),
          );
          before = r.next ?? undefined;
        } while (before !== undefined && events.length < history.limit);
        return events.slice(0, history.limit);
      }),
    count: (prefix) =>
      serial(async () => (await read({ kind: "count", prefix })).value),
    max: (prefix) =>
      serial(async () => (await read({ kind: "max", prefix })).value),
  } satisfies AsyncStateClient);
}
