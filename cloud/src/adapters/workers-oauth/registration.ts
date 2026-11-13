import { sha256 } from "../../tokens.ts";
import type { RedemptionNamespace } from "./redemption.ts";
import { BODY_LIMIT_BYTES, boundedBody } from "./body.ts";
import { configUnavailable } from "../../auth/compose.ts";
export const AUTHORIZATION_START_LIMITS = {
  perIP: 10,
  global: 100,
  windowMs: 600_000,
} as const;
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
const authorizationLimited = (
  retry = AUTHORIZATION_START_LIMITS.windowMs / 1000,
) =>
  Response.json(
    { error: { code: "AUTHORIZATION_RATE_LIMITED" } },
    {
      status: 429,
      headers: { "Cache-Control": "no-store", "Retry-After": String(retry) },
    },
  );
const authorizationUnavailable = () =>
  configUnavailable(
    "REGISTRATION_LIMITER",
    "Authorization admission unavailable",
  );
export class RegistrationLimiter {
  readonly #storage: LimitState["storage"];
  readonly #clock: { now(): number };
  constructor(state: LimitState, _env?: unknown, clock = { now: Date.now }) {
    this.#storage = state.storage;
    this.#clock = clock;
  }
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname,
      authorization = path.startsWith("/authorize/"),
      ip = path.slice(authorization ? 11 : 1),
      policy = authorization ? AUTHORIZATION_START_LIMITS : REGISTRATION_LIMITS,
      now = this.#clock.now();
    if (
      !/^[a-f0-9]{64}$/.test(ip) ||
      !Number.isFinite(now) ||
      (authorization &&
        (request.method !== "POST" || !Number.isSafeInteger(now) || now < 0))
    )
      return authorization ? authorizationUnavailable() : limited();
    const window = Math.floor(now / policy.windowMs);
    return this.#storage.transaction(async (store) => {
      const empty = { window, total: 0, ips: {} as Record<string, number> };
      let counts = await store.get<typeof empty>("window");
      if (counts?.window !== window) counts = empty;
      if (
        counts.total >= policy.global ||
        (counts.ips[ip] ?? 0) >= policy.perIP
      )
        return (authorization ? authorizationLimited : limited)(
          Math.max(1, Math.ceil(((window + 1) * policy.windowMs - now) / 1000)),
        );
      counts.total++;
      counts.ips[ip] = (counts.ips[ip] ?? 0) + 1;
      await store.put("window", counts);
      return new Response();
    });
  }
}
export async function guardAuthorizationStart(
  request: Request,
  namespace: unknown,
) {
  const raw = request.headers.get("CF-Connecting-IP");
  let address: string;
  try {
    if (!raw || !/^[\da-fA-F:.]+$/.test(raw)) return authorizationLimited();
    const ipv6 = raw.includes(":");
    if (!ipv6 && !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(raw))
      return authorizationLimited();
    address = new URL(`http://${ipv6 ? `[${raw}]` : raw}/`).hostname.replace(
      /^\[|\]$/g,
      "",
    );
    if (!ipv6 && address !== raw) return authorizationLimited();
  } catch {
    return authorizationLimited();
  }
  try {
    const service = namespace as RedemptionNamespace | undefined;
    if (
      typeof service?.idFromName !== "function" ||
      typeof service.get !== "function"
    )
      return authorizationUnavailable();
    const response = await service
      .get(service.idFromName("authorizations"))
      .fetch(
        new Request(
          `https://registration.internal/authorize/${await sha256(address)}`,
          { method: "POST" },
        ),
      );
    if (response.status === 200) return;
    const retry = Number(response.headers.get("Retry-After"));
    if (
      response.status === 429 &&
      Number.isInteger(retry) &&
      retry >= 1 &&
      retry <= 600
    ) {
      const body = (await response.json()) as { error?: { code?: unknown } };
      if (body?.error?.code === "AUTHORIZATION_RATE_LIMITED")
        return authorizationLimited(retry);
    }
  } catch {
    /* A committed admission may have lost its reply; never retry. */
  }
  return authorizationUnavailable();
}
/** The only hosts a loopback redirect may name (RFC 8252 section 7.3). */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "[::1]",
  "localhost",
]);
const unsafe = (uri: string) =>
  uri.includes("\\") ||
  [...uri].some((char) => {
    const code = char.charCodeAt(0);
    return code <= 32 || (code >= 127 && code <= 159);
  });
const parse = (uri: string) => {
  try {
    return unsafe(uri) ? undefined : new URL(uri);
  } catch {
    return undefined;
  }
};
export function isLoopbackRedirect(uri: string) {
  const url = parse(uri);
  return (
    url !== undefined &&
    url.protocol === "http:" &&
    LOOPBACK_HOSTS.has(url.hostname) &&
    !(url.username || url.password || url.hash || uri.includes("#"))
  );
}
const allowedRedirect = (uri: string, named: readonly string[]) =>
  isLoopbackRedirect(uri) || named.includes(parse(uri)?.href ?? "");
export async function guardRegistration(
  request: Request,
  namespace: unknown,
  named: readonly string[] = [],
) {
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
      !Array.isArray(uris) ||
      uris.length === 0 ||
      uris.length > REGISTRATION_LIMITS.redirects ||
      uris.some(
        (uri: unknown) =>
          typeof uri !== "string" ||
          uri.length > REGISTRATION_LIMITS.redirectLength ||
          !allowedRedirect(uri, named),
      )
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
