import type { VerifiedIdentity } from "../../../src/ports/identity.ts";

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
  | "issuance_failed";
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
  identity?: VerifiedIdentity;
}
export interface ChallengeState {
  challenges: ChallengeRecord[];
  attempts: number;
  resetAt: number;
}
/** The storage adapter serializes the entire synchronous operation across callers. */
export interface ChallengeStore {
  transaction<T>(operation: (state: ChallengeState) => T): T;
}
export interface DeviceLoginOptions {
  readonly store: ChallengeStore;
  readonly now: () => number;
  readonly random: (length: number) => Uint8Array;
  readonly issue: (
    identity: VerifiedIdentity,
    device: DeviceInfo,
  ) => Promise<string>;
}
export interface DeviceLogin {
  start(device: DeviceInfo): Promise<DeviceChallenge>;
  approve(code: string, identity: VerifiedIdentity): Promise<LoginDecision>;
  deny(code: string, identity: VerifiedIdentity): Promise<LoginDecision>;
  poll(code: string): Promise<LoginResult>;
}

/** Compile-only contract stub for the initial failing CI proof. */
export function createDeviceLogin(_options: DeviceLoginOptions): DeviceLogin {
  return {
    start: () =>
      Promise.resolve({
        device_code: "",
        user_code: "",
        expires_in: 600,
        interval: 5,
      }),
    approve: () => Promise.resolve({ ok: false, error: "invalid_user_code" }),
    deny: () => Promise.resolve({ ok: false, error: "invalid_user_code" }),
    poll: () => Promise.resolve({ ok: false, error: "invalid_grant" }),
  };
}
