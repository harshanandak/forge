import type { ClockPort } from "../../../../../src/ports/clock.ts";
import type {
  IdentityResult,
  IdentityVerifier,
} from "../../../../../src/ports/identity.ts";

export interface ClerkBinding {
  verify(response: unknown): Promise<IdentityResult>;
}

export function createClerkBinding(
  verifier: IdentityVerifier,
  audience: string,
  clock: ClockPort,
): ClerkBinding {
  const invalid: IdentityResult = { ok: false, reason: "invalid_proof" };
  return {
    async verify(response) {
      try {
        if (
          typeof response !== "object" ||
          response === null ||
          Array.isArray(response) ||
          !Object.hasOwn(response, "id_token")
        )
          return invalid;
        const proof = (response as Record<string, unknown>).id_token;
        if (typeof proof !== "string" || !proof) return invalid;
        return await verifier.verify(proof, audience, clock.now());
      } catch {
        return invalid;
      }
    },
  };
}
