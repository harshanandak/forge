import type { ChallengeState, ChallengeStore } from "./device-login.ts";

/** Fixed lifetime of a device token minted by login: 30 days (owner decision A). */
export const LOGIN_TTL_MS = 2_592_000_000;

/** Imports the shared HMAC secret (base64url, at least 32 bytes) for the engine's user-code hashes. */
export async function importLoginKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    Buffer.from(secret, "base64url"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

// Placeholder store: it keeps state in memory only, so nothing survives and nothing is shared.
export function loginStore(_db: unknown): ChallengeStore {
  const state: ChallengeState = { challenges: [], attempts: {} };
  return { conditionalUpdate: (operation) => operation(state) };
}
