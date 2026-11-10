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
export type ClerkResult = IdentityResult & { error?: ClerkFailure };
export interface ClerkUpstream {
  begin(state: string): Promise<string>;
  verify(request: Request, now: number): Promise<ClerkResult>;
}

export function createClerkUpstream(
  config: ClerkConfig,
  _binding: ClerkBinding,
  _http: ClerkHttpPort,
  _clock: ClockPort,
): ClerkUpstream {
  return {
    begin: (state) =>
      Promise.resolve(
        `${config.authorizationUrl}?${new URLSearchParams({ state })}`,
      ),
    verify: () =>
      Promise.resolve({
        ok: false,
        reason: "invalid_proof",
        error: "malformed_response",
      }),
  };
}
