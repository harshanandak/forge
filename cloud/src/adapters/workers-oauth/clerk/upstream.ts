import type { ClockPort } from "../../../../../src/ports/clock.ts";
import type { IdentityResult } from "../../../../../src/ports/identity.ts";
import type { ClerkBinding } from "./index.ts";

export interface ClerkConfig {
  authorizationUrl: string;
  tokenUrl: string;
  redirectUri: string;
  clientId: string;
  timeoutMs: number;
}
export interface ClerkHttpPort {
  post(
    url: string,
    body: URLSearchParams,
    signal: AbortSignal,
  ): Promise<Response>;
}
export type ClerkFailure =
  | "consent_denied"
  | "upstream_error"
  | "unavailable"
  | "timeout"
  | "malformed_response"
  | "invalid_token";
export type ClerkResult = IdentityResult & {
  error?: ClerkFailure;
  readonly verifiedAudience?: string;
};
export interface ClerkUpstream {
  begin(state: string, verifier?: string): Promise<string>;
  verify(
    request: Request,
    now: number,
    verifier?: string,
  ): Promise<ClerkResult>;
}
export function createClerkUpstream(
  input: ClerkConfig,
  binding: ClerkBinding,
  http: ClerkHttpPort,
  clock: ClockPort,
): ClerkUpstream {
  const config = { ...input };
  const refusal = (error: ClerkFailure): ClerkResult => ({
    ok: false,
    reason: "invalid_proof",
    error,
  });
  let configured = false;
  try {
    configured =
      Number.isSafeInteger(config.timeoutMs) &&
      config.timeoutMs > 0 &&
      config.timeoutMs <= 2_147_483_647 &&
      typeof config.clientId === "string" &&
      !!config.clientId &&
      [config.authorizationUrl, config.tokenUrl, config.redirectUri].every(
        (value) => {
          const url = new URL(value);
          return (
            url.protocol === "https:" &&
            !(url.username || url.password || url.hash)
          );
        },
      );
  } catch {
    // Invalid settings remain unavailable without echoing their contents.
  }
  return {
    async begin(state, verifier) {
      if (!configured || !verifier || !/^[\w-]{43}$/.test(verifier))
        throw new Error("Clerk unavailable");
      const challenge = Buffer.from(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(verifier),
        ),
      ).toString("base64url");
      const url = new URL(config.authorizationUrl);
      for (const [name, value] of Object.entries({
        state,
        response_type: "code",
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        scope: "openid",
        code_challenge: challenge,
        code_challenge_method: "S256",
      }))
        url.searchParams.set(name, value);
      return Promise.resolve(url.href);
    },
    async verify(request, now, verifier) {
      if (!configured) return refusal("unavailable");
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cancelBody: (() => void) | undefined;
      let expired = false,
        phase: ClerkFailure = "malformed_response";
      try {
        const url = new URL(request.url),
          target = new URL(config.redirectUri);
        if (
          url.origin !== target.origin ||
          url.pathname !== target.pathname ||
          url.hash
        )
          return refusal("malformed_response");
        const query = url.searchParams;
        if (query.has("error"))
          return refusal(
            query.getAll("error").length === 1 &&
              query.get("error") === "access_denied"
              ? "consent_denied"
              : "upstream_error",
          );
        const [code, ...extra] = query.getAll("code");
        if (extra.length || !code || code.length > 16_384)
          return refusal("malformed_response");
        if (!verifier || !/^[\w-]{43}$/.test(verifier))
          return refusal("malformed_response");
        const startedAt = clock.now(),
          until = startedAt + config.timeoutMs;
        if (!Number.isFinite(now) || !Number.isFinite(until) || startedAt < now)
          return refusal("unavailable");
        phase = "unavailable";
        const deadline = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            expired = true;
            reject(new Error("Clerk timeout"));
            controller.abort();
            cancelBody?.();
          }, config.timeoutMs);
        });
        // Cover HTTP, body reads and verification even if a port ignores abort.
        const result = await Promise.race([
          (async () => {
            const response = await http.post(
              config.tokenUrl,
              new URLSearchParams({
                grant_type: "authorization_code",
                code,
                client_id: config.clientId,
                redirect_uri: config.redirectUri,
                code_verifier: verifier,
              }),
              controller.signal,
            );
            if (
              controller.signal.aborted ||
              !response.ok ||
              response.redirected
            ) {
              void response.body?.cancel().catch(() => {});
              throw new Error("Clerk unavailable");
            }
            phase = "malformed_response";
            const reader = response.body?.getReader();
            if (!reader) throw new Error("Missing body");
            cancelBody = () => {
              cancelBody = undefined;
              void reader.cancel().catch(() => {});
              reader.releaseLock();
            };
            const decoder = new TextDecoder("utf-8", { fatal: true });
            let text = "",
              size = 0;
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              const bytes: unknown = chunk.value;
              if (!(bytes instanceof Uint8Array))
                throw new Error("Invalid chunk");
              size += bytes.byteLength;
              if (size > 65_536) throw new Error("Body too large");
              text += decoder.decode(bytes, { stream: true });
            }
            text += decoder.decode();
            const payload: unknown = JSON.parse(text);
            if (
              typeof payload !== "object" ||
              payload === null ||
              Array.isArray(payload) ||
              Object.hasOwn(payload, "error") ||
              !Object.hasOwn(payload, "id_token") ||
              typeof (payload as Record<string, unknown>).id_token !==
                "string" ||
              !(payload as Record<string, unknown>).id_token
            )
              return refusal("malformed_response");
            phase = "invalid_token";
            const verified = await binding.verify(payload);
            // The binding checks its configured ID-token audience, not the Forge resource.
            return verified.ok
              ? { ...verified, verifiedAudience: verified.identity.audience }
              : { ...verified, error: "invalid_token" as const };
          })(),
          deadline,
        ]);
        const at = clock.now();
        if (!Number.isFinite(at) || at < startedAt)
          return refusal("unavailable");
        if (at >= until) return refusal("timeout");
        return result;
      } catch {
        return refusal(expired ? "timeout" : phase);
      } finally {
        clearTimeout(timer);
        controller.abort();
        cancelBody?.();
      }
    },
  };
}
