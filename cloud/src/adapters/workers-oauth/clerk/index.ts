import type { ClockPort } from "../../../../../src/ports/clock.ts";
import type {
  IdentityResult,
  IdentityVerifier,
} from "../../../../../src/ports/identity.ts";

export interface ClerkBinding {
  verify(response: unknown): Promise<IdentityResult>;
}

export function createClerkBinding(
  _verifier: IdentityVerifier,
  _audience: string,
  _clock: ClockPort,
): ClerkBinding {
  return {
    verify: () => Promise.resolve({ ok: false, reason: "invalid_proof" }),
  };
}
