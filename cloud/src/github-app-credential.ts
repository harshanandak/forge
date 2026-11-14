import { createGithubJsonBudget, parseGithubJson } from "./github-json.ts";
import { isPlainJson } from "./plain-json.ts";
type Credential = Readonly<{ token: string; expiresAt: number }>;
export type GithubCredentialPorts = Readonly<{
  fetch(url: string, init: RequestInit): Promise<Response>;
  now(): number;
  deadline(expire: () => void, ms: number): () => void;
}>;
export type GithubAppBindings = Readonly<{
  GITHUB_APP_ID?: unknown;
  GITHUB_APP_INSTALLATION_ID?: unknown;
  GITHUB_APP_PRIVATE_KEY?: unknown;
  GITHUB_REPOSITORY_ID?: unknown;
}>;

export function createGithubAppCredential(
  env: GithubAppBindings,
  ports: GithubCredentialPorts,
): (repositoryId: number, signal: AbortSignal) => Promise<Credential | null> {
  let cached: Credential | undefined;
  const admitted = bindingId(env.GITHUB_REPOSITORY_ID),
    app = bindingId(env.GITHUB_APP_ID),
    installation = bindingId(env.GITHUB_APP_INSTALLATION_ID),
    pem = env.GITHUB_APP_PRIVATE_KEY;
  return async (repositoryId, signal) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    let clear = () => {};
    try {
      if (
        signal.aborted ||
        !admitted ||
        repositoryId !== admitted ||
        !app ||
        !installation ||
        typeof pem !== "string" ||
        pem.length > 16_384
      )
        return null;
      const match =
        /^-----BEGIN PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)\s+-----END PRIVATE KEY-----$/.exec(
          pem.trim(),
        );
      if (!match) return null;
      const start = ports.now();
      if (!Number.isFinite(start)) return null;
      if (cached && start < cached.expiresAt - 60_000) return cached;
      cached = undefined;
      const expired = () => {
        const now = ports.now();
        return (
          controller.signal.aborted ||
          !Number.isFinite(now) ||
          now - start >= 10_000
        );
      };
      const check = () => {
        if (expired()) throw new Error("GitHub credential unavailable");
      };
      const interrupted = new Promise<null>((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(null), {
          once: true,
        });
      });
      signal.addEventListener("abort", abort, { once: true });
      clear = ports.deadline(abort, 10_000);
      const mint = async (): Promise<Credential | null> => {
        check();
        const key = await crypto.subtle.importKey(
          "pkcs8",
          Uint8Array.from(atob(match[1]!.replace(/\s/g, "")), (c) =>
            c.charCodeAt(0),
          ),
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["sign"],
        );
        check();
        const seconds = Math.floor(ports.now() / 1000);
        const unsigned = `${encode(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })))}.${encode(new TextEncoder().encode(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: String(app) })))}`;
        const signature = await crypto.subtle.sign(
          "RSASSA-PKCS1-v1_5",
          key,
          new TextEncoder().encode(unsigned),
        );
        check();
        const url = `https://api.github.com/app/installations/${installation}/access_tokens`;
        const response = await ports.fetch(url, {
          method: "POST",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${unsigned}.${encode(new Uint8Array(signature))}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            repository_ids: [admitted],
            permissions: READ,
          }),
        });
        if (
          expired() ||
          response.status !== 201 ||
          response.redirected ||
          (response.url && response.url !== url) ||
          response.headers.get("X-RateLimit-Remaining") === "0"
        ) {
          void response.body?.cancel().catch(() => {});
          return null;
        }
        check();
        const parsed = await parseGithubJson(
          response,
          createGithubJsonBudget(),
          controller.signal,
        );
        check();
        if (!parsed.ok) return null;
        const token = scopedToken(parsed.value, admitted, ports.now());
        if (token && ports.now() < token.expiresAt - 60_000) cached = token;
        return token;
      };
      return await Promise.race([mint(), interrupted]);
    } catch {
      return null;
    } finally {
      signal.removeEventListener("abort", abort);
      controller.abort();
      try {
        clear();
      } catch {
        /* Cleanup never exposes injected errors. */
      }
    }
  };
}

const READ = Object.freeze({
  actions: "read",
  checks: "read",
  contents: "read",
  metadata: "read",
  pull_requests: "read",
});
function scopedToken(
  value: unknown,
  repositoryId: number,
  now: number,
): Credential | null {
  if (!isPlainJson(value) || !record(value)) return null;
  if (
    Object.keys(value).some(
      (k) =>
        ![
          "token",
          "expires_at",
          "permissions",
          "repository_selection",
          "repositories",
        ].includes(k),
    ) ||
    typeof value.token !== "string" ||
    !value.token.trim() ||
    /[\s\p{Cc}]/u.test(value.token) ||
    typeof value.expires_at !== "string" ||
    !Number.isFinite(Date.parse(value.expires_at)) ||
    Date.parse(value.expires_at) <= now ||
    value.repository_selection !== "selected" ||
    !record(value.permissions) ||
    Object.entries(value.permissions).some(
      ([k, v]) => !Object.hasOwn(READ, k) || v !== "read",
    )
  )
    return null;
  if (
    Object.hasOwn(value, "repositories") &&
    (!Array.isArray(value.repositories) ||
      value.repositories.length !== 1 ||
      !record(value.repositories[0]) ||
      value.repositories[0].id !== repositoryId)
  )
    return null;
  return Object.freeze({
    token: value.token,
    expiresAt: Date.parse(value.expires_at),
  });
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function bindingId(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^[1-9]\d{0,15}$/.test(value))
    return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : undefined;
}
