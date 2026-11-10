import type {
  CodeRedemption as RedemptionPort,
  OAuthStorage,
} from "./index.ts";

export interface ClaimStore {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: number): Promise<void>;
}
export interface ClaimState {
  storage: ClaimStore & {
    transaction<T>(operation: (store: ClaimStore) => Promise<T>): Promise<T>;
  };
}
export interface RedemptionNamespace {
  idFromName(hash: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

// Fail-closed stubs for the tests-first CI checkpoint; public routes stay refused.
export class CodeRedemption {
  constructor(_state: ClaimState) {}
  fetch(_request: Request): Promise<Response> {
    return Promise.resolve(
      Response.json({ error: "invalid_grant" }, { status: 400 }),
    );
  }
}
export function durableRedemption(
  _namespace: RedemptionNamespace,
): RedemptionPort {
  return { claimOnce: () => Promise.resolve(false) };
}
export function validateCodeBindings(
  _form: FormData,
  _storage: OAuthStorage,
): Promise<boolean> {
  return Promise.resolve(false);
}
