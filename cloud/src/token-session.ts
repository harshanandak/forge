// The one rule for a session-bound token: it acts only as its own session.
import { ForgeFailure } from "../../src/contract/failure.ts";

/** Refuses a body that names a session other than the one the token is bound to. A sessionless token is not limited. */
export function requireTokenSession(
  token: string | null | undefined,
  named: string | undefined,
): void {
  if (token != null && named !== undefined && named !== token)
    throw new ForgeFailure({
      code: "AUTH_DEVICE_MISMATCH",
      message: "The request names a session other than the token's",
      retry: "never",
    });
}
