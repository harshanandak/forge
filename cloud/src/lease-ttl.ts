// The bounds every lease acquisition shares, the raw claim route and the typed issue.claim alike: a
// ttl is a positive safe integer, at most 24 hours, and never past the token's own expiry.
import { fail } from "./issue-read.ts";

export const MAX_LEASE_MS = 24 * 60 * 60 * 1000;

/** Throws INPUT_INVALID unless `ttlMs` fits the cap and, when the token has an expiry, ends by it. */
export function checkTtl(ttlMs: unknown, expiresAt?: number): void {
  if (typeof ttlMs !== "number" || !Number.isSafeInteger(ttlMs) || ttlMs <= 0)
    throw fail("INPUT_INVALID", "ttlMs must be a positive safe integer");
  if (ttlMs > MAX_LEASE_MS)
    throw fail("INPUT_INVALID", "ttlMs is over 24 hours");
  if (expiresAt !== undefined && Date.now() + ttlMs > expiresAt)
    throw fail("INPUT_INVALID", "ttlMs would exceed the token expiry");
}
