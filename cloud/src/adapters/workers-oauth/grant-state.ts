import type { GrantRevocation } from "./index.ts";
import type { RedemptionNamespace } from "./redemption.ts";

export interface GrantStore {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: boolean): Promise<void>;
}
export interface GrantStorage extends GrantStore {
  transaction<T>(operation: (store: GrantStore) => Promise<T>): Promise<T>;
}
const hashPattern = /^[a-f0-9]{64}$/;
// Revoked markers have no expiry or alarm. Provider KV writes cannot reopen a grant.
export class GrantState {
  readonly #storage: GrantStorage;
  constructor(state: { storage: GrantStorage }, _env?: unknown) {
    this.#storage = state.storage;
  }
  async fetch(request: Request): Promise<Response> {
    if (
      !hashPattern.test(new URL(request.url).pathname.slice(1)) ||
      !["GET", "POST"].includes(request.method)
    )
      return new Response(null, { status: 400 });
    try {
      if (request.method === "POST") {
        await this.#storage.transaction(async (store) => {
          await store.put("revoked", true);
        });
        return new Response(null);
      }
      return new Response(null, {
        status: (await this.#storage.get("revoked")) === undefined ? 200 : 403,
      });
    } catch {
      return new Response(null, { status: 503 });
    }
  }
}
export function durableGrants(namespace: RedemptionNamespace): GrantRevocation {
  async function call(hash: string, method: string) {
    try {
      if (!hashPattern.test(hash)) throw new Error("Grant state unavailable");
      const response = await namespace
        .get(namespace.idFromName(hash))
        .fetch(new Request(`https://grant.internal/${hash}`, { method }));
      if (
        response.status !== 200 &&
        !(method === "GET" && response.status === 403)
      )
        throw new Error("Grant state unavailable");
      return response.status === 200;
    } catch {
      throw new Error("Grant state unavailable");
    }
  }
  return {
    isActive: (hash) => call(hash, "GET"),
    revoke: async (hash) => {
      await call(hash, "POST");
    },
  };
}
