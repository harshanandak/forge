import { REFRESH_TOKEN_TTL, type GrantRevocation } from "./index.ts";
import type { RedemptionNamespace } from "./redemption.ts";

export interface GrantStore {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  setAlarm?(at: number): Promise<void>;
}
export interface GrantStorage extends GrantStore {
  transaction<T>(operation: (store: GrantStore) => Promise<T>): Promise<T>;
}
interface Ledger {
  deadline: number;
  closed?: boolean;
  spent: Record<string, string>;
}
interface Claim {
  token: string;
  client: string;
  deadline: number;
  current: boolean;
}
const hashPattern = /^[a-f0-9]{64}$/;
// Revoked markers have no expiry or alarm. Provider KV writes cannot reopen a grant.
export class GrantState {
  readonly #storage: GrantStorage;
  readonly #clock: { now(): number };
  constructor(
    state: { storage: GrantStorage },
    _env?: unknown,
    clock = { now: Date.now },
  ) {
    this.#storage = state.storage;
    this.#clock = clock;
  }
  async alarm(): Promise<void> {
    await this.#storage.transaction(async (store) => {
      const state = await store.get<Ledger>("refresh");
      if (!state) return;
      if (this.#clock.now() < state.deadline + 30000)
        await store.setAlarm!(state.deadline + 30000);
      else
        await store.put("refresh", {
          deadline: state.deadline,
          closed: true,
          spent: {},
        });
    });
  }
  #claim(input: Claim): Promise<number> {
    return this.#storage.transaction(async (store) => {
      const state = await store.get<Ledger>("refresh");
      if (
        (await store.get("revoked")) ||
        state?.closed ||
        (state && state.deadline !== input.deadline)
      )
        return 400;
      if (state?.spent[input.token] === input.client) {
        await store.put("revoked", true);
        return 409;
      }
      if (!input.current) return 400;
      const next = state ?? { deadline: input.deadline, spent: {} };
      next.spent[input.token] = input.client;
      await store.put("refresh", next);
      await store.setAlarm!(input.deadline + 30000);
      return 200;
    });
  }
  async fetch(request: Request): Promise<Response> {
    if (
      !hashPattern.test(new URL(request.url).pathname.slice(1)) ||
      !["GET", "POST"].includes(request.method)
    )
      return new Response(null, { status: 400 });
    try {
      const url = new URL(request.url),
        token = url.searchParams.get("token"),
        client = url.searchParams.get("client");
      if (request.method === "GET" && token && client) {
        const state = await this.#storage.get<Ledger>("refresh");
        return new Response(null, {
          status: state?.spent[token] === client ? 200 : 403,
        });
      }
      if (request.method === "POST") {
        if (request.headers.get("Content-Type") === "application/json") {
          const input = (await request.json()) as Claim,
            now = this.#clock.now();
          if (
            !hashPattern.test(input.token) ||
            !hashPattern.test(input.client) ||
            typeof input.current !== "boolean" ||
            !Number.isSafeInteger(input.deadline) ||
            !Number.isFinite(now) ||
            input.deadline - now < 60000 ||
            input.deadline > now + REFRESH_TOKEN_TTL * 1000 + 30000
          )
            return new Response(null, { status: 400 });
          return new Response(null, { status: await this.#claim(input) });
        }
        await this.#storage.transaction(async (store) => {
          await store.put("revoked", true);
        });
        return new Response(null);
      }
      return new Response(null, {
        status:
          (await this.#storage.get("revoked")) === undefined &&
          !(await this.#storage.get<Ledger>("refresh"))?.closed
            ? 200
            : 403,
      });
    } catch {
      return new Response(null, { status: 503 });
    }
  }
}
export function durableGrants(namespace: RedemptionNamespace): GrantRevocation {
  async function call(hash: string, method: string, body?: Claim, query = "") {
    try {
      if (!hashPattern.test(hash)) throw new Error("Grant state unavailable");
      const response = await namespace.get(namespace.idFromName(hash)).fetch(
        new Request(`https://grant.internal/${hash}${query}`, {
          method,
          body: body ? JSON.stringify(body) : null,
          headers: body ? { "Content-Type": "application/json" } : {},
        }),
      );
      if (
        response.status !== 200 &&
        !(
          (method === "GET" && response.status === 403) ||
          (body && [400, 409].includes(response.status))
        )
      )
        throw new Error("Grant state unavailable");
      return response.status;
    } catch {
      throw new Error("Grant state unavailable");
    }
  }
  return {
    isActive: async (hash) => (await call(hash, "GET")) === 200,
    spent: async (hash, token, client) => {
      const query = `?token=${token}&client=${client}`;
      return (await call(hash, "GET", undefined, query)) === 200;
    },
    claim: async (hash, token, client, deadline, current) => {
      const body = { token, client, deadline, current };
      const status = await call(hash, "POST", body);
      return status === 200 ? "won" : status === 409 ? "reused" : "refused";
    },
    revoke: async (hash) => {
      await call(hash, "POST");
    },
  };
}
