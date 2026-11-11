import { sha256 } from "../../tokens.ts";
import type { RedemptionNamespace } from "./redemption.ts";
import { BODY_LIMIT_BYTES, boundedBody } from "./body.ts";
export const REGISTRATION_LIMITS = {
  perIP: 5,
  global: 100,
  windowMs: 3_600_000,
  bodyBytes: BODY_LIMIT_BYTES,
  redirects: 5,
  redirectLength: 512,
  clientTTL: 86400,
} as const;
export interface RegistrationStore {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}
export interface LimitState {
  storage: RegistrationStore & {
    transaction<T>(run: (store: RegistrationStore) => Promise<T>): Promise<T>;
  };
}
const limited = (retry = REGISTRATION_LIMITS.windowMs / 1000) =>
  Response.json(
    { error: { code: "REGISTRATION_RATE_LIMITED" } },
    { status: 429, headers: { "Retry-After": String(retry) } },
  );
const invalid = (field: string) =>
  Response.json(
    { error: { code: "REGISTRATION_INVALID", field } },
    { status: 400 },
  );
export class RegistrationLimiter {
  readonly #storage: LimitState["storage"];
  readonly #clock: { now(): number };
  constructor(state: LimitState, _env?: unknown, clock = { now: Date.now }) {
    this.#storage = state.storage;
    this.#clock = clock;
  }
  async fetch(request: Request): Promise<Response> {
    const ip = new URL(request.url).pathname.slice(1),
      now = this.#clock.now();
    if (!/^[a-f0-9]{64}$/.test(ip) || !Number.isFinite(now)) return limited();
    const window = Math.floor(now / REGISTRATION_LIMITS.windowMs);
    return this.#storage.transaction(async (store) => {
      const empty = { window, total: 0, ips: {} as Record<string, number> };
      let counts = await store.get<typeof empty>("window");
      if (counts?.window !== window) counts = empty;
      if (
        counts.total >= REGISTRATION_LIMITS.global ||
        (counts.ips[ip] ?? 0) >= REGISTRATION_LIMITS.perIP
      )
        return limited(
          Math.ceil(((window + 1) * REGISTRATION_LIMITS.windowMs - now) / 1000),
        );
      counts.total++;
      counts.ips[ip] = (counts.ips[ip] ?? 0) + 1;
      await store.put("window", counts);
      return new Response();
    });
  }
}
export async function guardRegistration(request: Request, namespace: unknown) {
  if (
    new URL(request.url).pathname !== "/register" ||
    request.method !== "POST"
  )
    return;
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip) return limited();
  try {
    const body = await boundedBody(
      request.clone(),
      REGISTRATION_LIMITS.bodyBytes,
    );
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      await body.arrayBuffer(),
    );
    const data = JSON.parse(text) as {
      redirect_uris?: unknown;
    };
    const uris = data?.redirect_uris;
    if (
      uris !== undefined &&
      (!Array.isArray(uris) ||
        uris.length > REGISTRATION_LIMITS.redirects ||
        uris.some(
          (uri: unknown) =>
            typeof uri !== "string" ||
            uri.length > REGISTRATION_LIMITS.redirectLength,
        ))
    )
      return invalid("redirect_uris");
  } catch {
    return invalid("body");
  }
  const service = namespace as RedemptionNamespace;
  const response = await service.get(service.idFromName("registrations")).fetch(
    new Request(`https://registration.internal/${await sha256(ip)}`, {
      method: "POST",
    }),
  );
  return response.ok
    ? undefined
    : limited(Number(response.headers.get("Retry-After")) || undefined);
}
