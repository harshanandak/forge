import type { ClockPort } from "../../ports/clock.ts";
import { IdentityVerifier, type IdentityResult } from "../../ports/identity.ts";

export interface OidcConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly algorithms: readonly string[];
  readonly jwksUrl: string;
  readonly cacheTtlMs: number;
  readonly refreshIntervalMs: number;
}

export interface OidcHttpPort {
  get(url: string): Promise<unknown>;
}

export function createOidcVerifier(
  _config: OidcConfig,
  _http: OidcHttpPort,
  _clock: ClockPort,
): IdentityVerifier {
  return new (class extends IdentityVerifier {
    verify(
      _proof: unknown,
      _audience: string,
      _now: number,
    ): Promise<IdentityResult> {
      return Promise.resolve({ ok: false, reason: "invalid_proof" });
    }
  })();
}
