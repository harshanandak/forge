import type { SqlDatabase } from "../../../src/ports/store.ts";
import { createDeviceLogin, type ChallengeStore } from "./device-login.ts";

// Tests-first scaffold: shared SQL persistence and token delivery follow the red CI run.
export function projectChallengeStore(_db: SqlDatabase): ChallengeStore {
  return {
    conditionalUpdate: (operation) =>
      operation({ challenges: [], attempts: {} }),
  };
}

export async function createProjectLogin(
  db: SqlDatabase,
  vars: Readonly<Record<string, unknown>>,
  now: () => number = Date.now,
) {
  const userCodeKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(vars.DEVICE_LOGIN_HMAC_KEY)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return createDeviceLogin({
    store: projectChallengeStore(db),
    userCodeKey,
    now,
    random: (length) => crypto.getRandomValues(new Uint8Array(length)),
    issue: () => Promise.reject(new Error("Project token delivery pending")),
  });
}
