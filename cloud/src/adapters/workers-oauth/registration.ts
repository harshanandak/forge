export const REGISTRATION_LIMITS = {
  perIP: 5,
  global: 100,
  windowMs: 3_600_000,
  bodyBytes: 8192,
  redirects: 5,
  redirectLength: 512,
  clientTTL: 86400,
} as const;
export interface RegistrationStore {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}
export interface RegistrationState {
  storage: RegistrationStore & {
    transaction<T>(run: (store: RegistrationStore) => Promise<T>): Promise<T>;
  };
}
// Fail-closed stub for the tests-first CI checkpoint.
export class RegistrationLimiter {
  constructor(
    _state: RegistrationState,
    _env?: unknown,
    _clock = { now: Date.now },
  ) {}
  fetch(_request: Request): Promise<Response> {
    return Promise.resolve(
      Response.json(
        { error: { code: "REGISTRATION_UNAVAILABLE" } },
        { status: 503 },
      ),
    );
  }
}
