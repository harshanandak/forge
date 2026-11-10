import type {
  CodeRedemption as RedemptionPort,
  OAuthStorage,
} from "./index.ts";

export interface ClaimStore {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: number): Promise<void>;
}
export interface ClaimState {
  storage: ClaimStore & {
    transaction<T>(operation: (store: ClaimStore) => Promise<T>): Promise<T>;
  };
}
export interface RedemptionNamespace {
  idFromName(hash: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

const hashPattern = /^[a-f0-9]{64}$/;
const refusal = (error = "invalid_grant", status = 400) =>
  Response.json({ error }, { status });
export class CodeRedemption {
  readonly #storage: ClaimState["storage"];
  constructor(state: ClaimState) {
    this.#storage = state.storage;
  }
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url),
        hash = url.pathname.slice(1);
      const expiresAt = Number(url.searchParams.get("until"));
      if (
        request.method !== "POST" ||
        !hashPattern.test(hash) ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= Date.now()
      )
        return refusal();
      const won = await this.#storage.transaction(async (store) => {
        // Keep a permanent tombstone: stale provider KV must never resurrect a code.
        if ((await store.get(hash)) !== undefined) return false;
        await store.put(hash, expiresAt);
        return true;
      });
      return won ? Response.json({ claimed: true }) : refusal();
    } catch {
      return refusal("temporarily_unavailable", 503);
    }
  }
}
export function durableRedemption(
  namespace: RedemptionNamespace,
): RedemptionPort {
  return {
    async claimOnce(hash, expiresAt) {
      if (!hashPattern.test(hash)) return false;
      const response = await namespace
        .get(namespace.idFromName(hash))
        .fetch(
          new Request(
            `https://redemption.internal/${hash}?until=${expiresAt}`,
            { method: "POST" },
          ),
        );
      if (response.status !== 200 && response.status !== 400)
        throw new Error("Redemption unavailable");
      return response.status === 200;
    },
  };
}
export async function validateCodeBindings(
  form: { get(key: string): unknown; getAll(key: string): unknown[] },
  storage: OAuthStorage,
): Promise<boolean> {
  const fields = "code client_id redirect_uri code_verifier grant_type".split(
    " ",
  );
  if (
    fields.some(
      (key) =>
        form.getAll(key).length !== 1 ||
        typeof form.get(key) !== "string" ||
        !form.get(key),
    )
  )
    return false;
  const code = form.get("code") as string;
  const parts = code.split(":"),
    [user, id] = parts;
  if (
    parts.length !== 3 ||
    parts.some((part) => !part) ||
    form.get("grant_type") !== "authorization_code"
  )
    return false;
  const grant = await storage.get<Record<string, unknown>>(
    `grant:${user}:${id}`,
    { type: "json" },
  );
  const digest = async (value: string) =>
    Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    );
  return (
    !!grant &&
    grant.authCodeId === (await digest(code)).toString("hex") &&
    grant.clientId === form.get("client_id") &&
    grant.redirectUri === form.get("redirect_uri") &&
    grant.codeChallengeMethod === "S256" &&
    grant.codeChallenge ===
      (await digest(form.get("code_verifier") as string)).toString("base64url")
  );
}
