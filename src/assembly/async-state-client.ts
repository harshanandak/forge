import type { AsyncStateClient, ExtendedStateClient } from "../ports/state.ts";

// Execute now, preserving local ordering while turning thrown refusals into rejections.
const promise = <T>(call: () => T): Promise<T> =>
  new Promise((resolve) => resolve(call()));

/** Adapt an already-bound client: its owner, grant checks and lifetime stay authoritative. */
export function createLocalAsyncStateClient(
  client: ExtendedStateClient,
): AsyncStateClient {
  return Object.freeze({
    get: (key) => promise(() => client.get(key)),
    put: (key, value, options) =>
      promise(() => client.put(key, value, options)),
    putMany: (entries, options) =>
      promise(() => client.putMany(entries, options)),
    range: (options) => promise(() => client.listRange(options)),
    history: (options) => promise(() => client.history(options)),
    count: (prefix) => promise(() => client.count(prefix)),
    max: (prefix) => promise(() => client.maxNumber(prefix)),
  } satisfies AsyncStateClient);
}
