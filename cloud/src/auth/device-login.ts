import type {
  IdentityClaims,
  VerifiedIdentity,
} from "../../../src/ports/identity.ts";
import { isVerifiedIdentity } from "../../../src/ports/identity-mint.ts";
import { same, sha256 as hash } from "../tokens.ts";

export interface DeviceInfo {
  readonly label: string;
}
export interface DeviceChallenge {
  readonly device_code: string;
  readonly user_code: string;
  readonly expires_in: number;
  readonly interval: number;
}
export type LoginError =
  | "authorization_pending"
  | "slow_down"
  | "expired_token"
  | "access_denied"
  | "invalid_grant"
  | "invalid_user_code"
  | "rate_limited"
  | "issuance_failed"
  | "unavailable";
export type LoginRefusal = {
  readonly ok: false;
  readonly error: LoginError;
  readonly interval?: number;
};
export type LoginDecision = { readonly ok: true } | LoginRefusal;
export type LoginResult =
  { readonly ok: true; readonly credential: string } | LoginRefusal;
export interface ChallengeRecord {
  deviceHash: string;
  userHash: string;
  deviceInfo: DeviceInfo;
  expiresAt: number;
  interval: number;
  nextPoll: number;
  status: "pending" | "approved" | "denied" | "consumed";
  identity?: IdentityClaims;
}
export interface ChallengeState {
  challenges: ChallengeRecord[];
  attempts: Record<string, { failed: number; resetAt: number }>;
}
/**
 * Run the callback as one atomic conditional update of shared storage, including
 * its reads, status predicates, attempt counter and writes. Commit only on return;
 * roll back on throw. No await or external side effect is allowed in the callback.
 * Adapters MUST use a backing-store transaction or conditional write that holds
 * across Worker instances. An in-process lock does not satisfy this contract.
 */
export interface ChallengeStore {
  conditionalUpdate<T>(operation: (state: ChallengeState) => T): T;
}
export interface DeviceLoginOptions {
  readonly store: ChallengeStore;
  readonly now: () => number;
  readonly random: (length: number) => Uint8Array;
  /** Shared HMAC-SHA-256 key supplied by composition; never persisted here. */
  readonly userCodeKey: Parameters<typeof crypto.subtle.sign>[1];
  readonly issue: (
    identity: IdentityClaims,
    device: DeviceInfo,
  ) => Promise<string>;
}
export interface DeviceLogin {
  start(device: DeviceInfo): Promise<DeviceChallenge>;
  approve(code: string, identity: VerifiedIdentity): Promise<LoginDecision>;
  deny(code: string, identity: VerifiedIdentity): Promise<LoginDecision>;
  poll(code: string): Promise<LoginResult>;
}
export class DeviceLoginFailure extends Error {
  readonly code: LoginError;
  constructor(code: LoginError) {
    super("Device login could not complete");
    this.name = "DeviceLoginFailure";
    this.code = code;
  }
}
const ALPHABET = "BCDFGHJKLMNPQRSTVWXYZ";
const LIFETIME = 600;
const INTERVAL = 5;
const ATTEMPTS = 5;
const WINDOW_MS = 60_000;

const refuse = (error: LoginError, interval?: number): LoginRefusal =>
  interval === undefined
    ? { ok: false, error }
    : { ok: false, error, interval };
/** Copy only authenticated claims; provider credentials cannot follow extra fields. */
function identityClaims(identity: IdentityClaims): IdentityClaims {
  const { issuer, subject, audience, expiresAt, authenticatedAt } = identity;
  return Object.freeze({
    issuer,
    subject,
    audience,
    expiresAt,
    authenticatedAt,
  });
}

export function createDeviceLogin(options: DeviceLoginOptions): DeviceLogin {
  const { store, now, random, issue, userCodeKey } = options;
  const algorithm = userCodeKey.algorithm as {
    name: string;
    hash: { name: string };
    length: number;
  };
  if (
    userCodeKey.type !== "secret" ||
    algorithm.name !== "HMAC" ||
    algorithm.hash.name !== "SHA-256" ||
    algorithm.length < 256 ||
    !userCodeKey.usages.includes("sign")
  )
    throw new DeviceLoginFailure("unavailable");
  async function keyedUserHash(code: string): Promise<string> {
    const signature = await crypto.subtle.sign(
      "HMAC",
      userCodeKey,
      new TextEncoder().encode("forge/device-login/user-code/v1\0" + code),
    );
    return Array.from(new Uint8Array(signature), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  }
  function bytes(length: number): Uint8Array {
    const value = random(length);
    if (value.length !== length) throw new DeviceLoginFailure("unavailable");
    return value;
  }
  function userCode(): string {
    let code = "";
    // Rejection sampling avoids modulo bias; bad entropy cannot loop forever.
    for (let batch = 0; batch < 16 && code.length < 8; batch++) {
      for (const byte of bytes(8)) {
        if (byte < 256 - (256 % ALPHABET.length) && code.length < 8)
          code += ALPHABET[byte % ALPHABET.length];
      }
    }
    if (code.length !== 8) throw new DeviceLoginFailure("unavailable");
    return code.slice(0, 4) + "-" + code.slice(4);
  }
  async function decide(
    code: string,
    identity: VerifiedIdentity,
    approve: boolean,
  ): Promise<LoginDecision> {
    const presented = await keyedUserHash(code);
    return store.conditionalUpdate((state) => {
      const time = now();
      if (
        !isVerifiedIdentity(identity) ||
        !Number.isFinite(time) ||
        !Number.isFinite(identity.expiresAt) ||
        time >= identity.expiresAt ||
        !identity.issuer ||
        !identity.subject
      )
        return refuse("access_denied");
      const principal = JSON.stringify([identity.issuer, identity.subject]);
      const budget = state.attempts[principal];
      if (
        budget !== undefined &&
        time < budget.resetAt &&
        budget.failed >= ATTEMPTS
      )
        return refuse("rate_limited");
      const record = state.challenges.find((row) =>
        same(row.userHash, presented),
      );
      if (record === undefined) {
        state.attempts[principal] = {
          failed:
            budget !== undefined && time < budget.resetAt
              ? budget.failed + 1
              : 1,
          resetAt:
            budget !== undefined && time < budget.resetAt
              ? budget.resetAt
              : time + WINDOW_MS,
        };
        return refuse("invalid_user_code");
      }
      if (record.status !== "pending") return refuse("invalid_user_code");
      if (time >= record.expiresAt) return refuse("expired_token");
      record.status = approve ? "approved" : "denied";
      if (approve) record.identity = identityClaims(identity);
      return { ok: true };
    });
  }
  const login: DeviceLogin = {
    async start(device) {
      for (let attempt = 0; attempt < 16; attempt++) {
        const device_code = btoa(String.fromCharCode(...bytes(32)))
          .replaceAll("+", "-")
          .replaceAll("/", "_")
          .replaceAll("=", "");
        const user_code = userCode();
        const [deviceHash, userHash] = await Promise.all([
          hash(device_code),
          keyedUserHash(user_code),
        ]);
        const inserted = store.conditionalUpdate((state) => {
          const time = now();
          if (!Number.isFinite(time))
            throw new DeviceLoginFailure("unavailable");
          if (
            state.challenges.some(
              (row) =>
                same(row.deviceHash, deviceHash) ||
                same(row.userHash, userHash),
            )
          )
            return false;
          state.challenges.push({
            deviceHash,
            userHash,
            deviceInfo: { label: device.label },
            expiresAt: time + LIFETIME * 1_000,
            interval: INTERVAL,
            nextPoll: time,
            status: "pending",
          });
          return true;
        });
        if (inserted)
          return {
            device_code,
            user_code,
            expires_in: LIFETIME,
            interval: INTERVAL,
          };
      }
      throw new DeviceLoginFailure("unavailable");
    },
    approve: (code, identity) => decide(code, identity, true),
    deny: (code, identity) => decide(code, identity, false),
    async poll(code) {
      const deviceHash = await hash(code);
      const result = store.conditionalUpdate((state) => {
        const record = state.challenges.find((row) =>
          same(row.deviceHash, deviceHash),
        );
        if (record === undefined || record.status === "consumed")
          return refuse("invalid_grant");
        const time = now();
        if (!Number.isFinite(time) || time >= record.expiresAt)
          return refuse("expired_token");
        if (record.status === "denied") return refuse("access_denied");
        if (time < record.nextPoll) {
          record.interval += 5;
          record.nextPoll = time + record.interval * 1_000;
          return refuse("slow_down", record.interval);
        }
        record.nextPoll = time + record.interval * 1_000;
        if (record.status === "pending") return refuse("authorization_pending");
        if (record.identity === undefined) return refuse("access_denied");
        // This conditional transition commits before issuance starts or awaits.
        record.status = "consumed";
        return {
          ok: true as const,
          identity: identityClaims(record.identity),
          device: { label: record.deviceInfo.label },
        };
      });
      if (!result.ok) return result;
      try {
        return {
          ok: true,
          credential: await issue(result.identity, result.device),
        };
      } catch {
        return refuse("issuance_failed");
      }
    },
  };
  return {
    start: (device) =>
      login.start(device).catch(() => {
        throw new DeviceLoginFailure("unavailable");
      }),
    approve: (code, identity) =>
      login.approve(code, identity).catch(() => refuse("unavailable")),
    deny: (code, identity) =>
      login.deny(code, identity).catch(() => refuse("unavailable")),
    poll: (code) => login.poll(code).catch(() => refuse("unavailable")),
  };
}
