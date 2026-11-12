// Device login through the project Durable Object. The engine (device-login.ts) keeps its state in
// one private row, updated inside the object's synchronous transaction; the token it mints lives in
// the same project database. This slice has no approve route: nothing here can approve a login.
import { ForgeFailure } from "../../../src/contract/failure.ts";
import type { SqlDatabase } from "../../../src/ports/store.ts";
import { issueToken, sha256 } from "../tokens.ts";
import {
  createDeviceLogin,
  DeviceLoginFailure,
  type ChallengeState,
  type ChallengeStore,
  type LoginError,
} from "./device-login.ts";

/** Fixed lifetime of a device token minted by login: 30 days (owner decision A). */
export const LOGIN_TTL_MS = 2_592_000_000;
export const LOGIN = "domain_cloud_login";
export const LOGIN_MIGRATION = {
  id: "003_cloud_login",
  statements: [
    `CREATE TABLE IF NOT EXISTS ${LOGIN} (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL)`,
  ],
};

/** Counters for the browser's approval attempts. They live outside the login row, so a refusal never writes it. */
export const LIMITS = "domain_cloud_browser_attempts";
export const LIMITS_MIGRATION = {
  id: "004_cloud_browser_attempts",
  statements: [
    `CREATE TABLE IF NOT EXISTS ${LIMITS} (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL)`,
  ],
};

// Public start budget: a fixed window, shared by the project and by each address.
const WINDOW_MS = 60_000;
const PROJECT_STARTS = 30;
const ADDRESS_STARTS = 5;
const DEVICE = /^[A-Za-z0-9][\w.:-]{0,127}$/;
const DEVICE_CODE = /^[A-Za-z0-9_-]{43}$/;
const SECRET = /^[A-Za-z0-9_-]{43,512}$/;
const NO_STORE = { "Cache-Control": "no-store" };

/** The Worker and object settings; read by name, so any shape of environment is accepted. */
export type LoginEnv = Readonly<Record<string, unknown>>;

export const isLoginRoute = (request: Request): boolean =>
  request.method === "POST" &&
  /^\/p\/[^/]+\/login(start|poll)$/.test(new URL(request.url).pathname);

/** Names the first missing setting login needs, or undefined when all are present. */
export function loginConfigGap(env: LoginEnv): string | undefined {
  if (
    typeof env.DEVICE_LOGIN_HMAC_KEY !== "string" ||
    !SECRET.test(env.DEVICE_LOGIN_HMAC_KEY) ||
    secretBytes(env.DEVICE_LOGIN_HMAC_KEY) === undefined
  )
    return "DEVICE_LOGIN_HMAC_KEY";
  return (
    ["CLERK_ISSUER", "FORGE_OWNER_SUBJECT", "CLERK_CLIENT_ID"] as const
  ).find((name) => typeof env[name] !== "string" || env[name] === "");
}

/** The secret's bytes, or undefined when it is not base64url of at least 32 bytes. */
function secretBytes(secret: string): Uint8Array | undefined {
  try {
    const raw = Uint8Array.from(
      atob(secret.replaceAll("-", "+").replaceAll("_", "/")),
      (char) => char.charCodeAt(0),
    );
    return raw.length >= 32 ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** Imports the shared HMAC secret for the engine's user-code hashes. */
export async function importLoginKey(secret: string): Promise<CryptoKey> {
  const raw = secretBytes(secret);
  if (raw === undefined) throw new DeviceLoginFailure("unavailable");
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

interface Window {
  count: number;
  resetAt: number;
}
interface Admission {
  project: Window;
  addresses: Record<string, Window>;
}
export interface LoginState extends ChallengeState {
  admission?: Admission;
  previews?: Admission;
}

const EMPTY = JSON.stringify({ challenges: [], attempts: {} });

/** The engine's store: one row, read, changed and written back inside one synchronous transaction. */
export function loginStore(db: SqlDatabase): ChallengeStore {
  return {
    conditionalUpdate: (operation) =>
      db.transaction(() => {
        const row = db.get(`SELECT state FROM ${LOGIN} WHERE id=1`);
        const before = row === undefined ? EMPTY : String(row.state);
        const state = JSON.parse(before) as LoginState;
        const result = operation(state);
        // A refusal changes nothing, so it writes nothing.
        const after = JSON.stringify(state);
        if (after !== before)
          db.run(
            `INSERT INTO ${LOGIN} (id, state) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET state=excluded.state`,
            [after],
          );
        return result;
      }),
  };
}

/**
 * Counts one use in a fixed window per address and per project; `charge: false` only asks whether there
 * is room. It changes the given state only, so a caller can decide and charge inside one transaction.
 */
export function spend(
  state: LoginState,
  address: string,
  now: number,
  key: "admission" | "previews" = "admission",
  charge = true,
): boolean {
  const budget = state[key] ?? {
    project: { count: 0, resetAt: 0 },
    addresses: {},
  };
  for (const [key, window] of Object.entries(budget.addresses))
    if (now >= window.resetAt) delete budget.addresses[key];
  if (now >= budget.project.resetAt)
    budget.project = { count: 0, resetAt: now + WINDOW_MS };
  const mine = budget.addresses[address];
  const allowed =
    budget.project.count < PROJECT_STARTS &&
    (mine?.count ?? 0) < ADDRESS_STARTS;
  if (allowed && charge) {
    budget.project.count++;
    budget.addresses[address] = {
      count: (mine?.count ?? 0) + 1,
      resetAt: mine?.resetAt ?? budget.project.resetAt,
    };
  }
  state[key] = budget;
  return allowed;
}
/**
 * Admits one browser attempt (approve, deny or callback) if the project, the address and, when it is
 * known, the challenge each have room in their fixed window, and charges all of them in one step. A
 * refusal charges nothing and does not move a window. Run it with no await before the decision.
 */
export function browserAttempt(
  db: SqlDatabase,
  address: string,
  challenge: string | undefined,
  now: number,
): boolean {
  return db.transaction(() => {
    const buckets: [string, number][] = [
      ["project", PROJECT_STARTS],
      [`address:${address}`, ADDRESS_STARTS],
      ...(challenge === undefined
        ? []
        : ([[`challenge:${challenge}`, ADDRESS_STARTS]] as [string, number][])),
    ];
    const full = buckets.some(([bucket, cap]) => {
      const row = db.get(
        `SELECT count, reset_at FROM ${LIMITS} WHERE bucket=?`,
        [bucket],
      );
      return (
        row !== undefined &&
        now < Number(row.reset_at) &&
        Number(row.count) >= cap
      );
    });
    if (full) return false;
    db.run(`DELETE FROM ${LIMITS} WHERE reset_at<=?`, [now]);
    for (const [bucket] of buckets)
      db.run(
        `INSERT INTO ${LIMITS} (bucket, count, reset_at) VALUES (?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET count=count+1`,
        [bucket, now + WINDOW_MS],
      );
    return true;
  });
}
const admit = (store: ChallengeStore, address: string, now: number) =>
  store.conditionalUpdate((state) => spend(state as LoginState, address, now));

const refusal = (error: LoginError, interval?: number) => ({
  ok: false as const,
  error,
  ...(interval === undefined ? {} : { interval }),
});
const STATUS: Partial<Record<LoginError, number>> = {
  rate_limited: 429,
  capacity_exceeded: 429,
  issuance_failed: 500,
  unavailable: 503,
};
const reply = (status: number, body: unknown): Response =>
  Response.json(body, { status, headers: NO_STORE });

/** Runs one login route against the project database. The caller has checked the project is provisioned. */
export async function loginRoute(
  db: SqlDatabase,
  env: LoginEnv,
  route: "loginstart" | "loginpoll",
  input: Record<string, unknown>,
  address: string | null,
  project: string,
): Promise<Response> {
  if (
    env.FORGE_CLOUD_PROJECT === undefined ||
    project !== env.FORGE_CLOUD_PROJECT
  )
    throw new ForgeFailure({
      code: "AUTH_FORBIDDEN",
      message: "Login is not available for this project",
      retry: "never",
    });
  const unavailable = () =>
    new ForgeFailure({
      code: "AUTH_CONFIG_UNAVAILABLE",
      message: "Login configuration unavailable",
      retry: "never",
    });
  if (loginConfigGap(env) !== undefined) throw unavailable();
  const userCodeKey = await importLoginKey(
    String(env.DEVICE_LOGIN_HMAC_KEY),
  ).catch(() => {
    throw unavailable();
  });
  const owner = {
    issuer: env.CLERK_ISSUER,
    subject: env.FORGE_OWNER_SUBJECT,
    audience: env.CLERK_CLIENT_ID,
  };
  const store = loginStore(db);
  const login = createDeviceLogin({
    store,
    userCodeKey,
    now: () => Date.now(),
    random: (length) => crypto.getRandomValues(new Uint8Array(length)),
    // Rechecked right before minting: only the configured owner, for the configured client, unexpired.
    issue: async (identity, device) => {
      const now = Date.now();
      if (
        identity.issuer !== owner.issuer ||
        identity.subject !== owner.subject ||
        identity.audience !== owner.audience ||
        !(identity.expiresAt > now)
      )
        throw new Error("Identity is not the owner");
      const token = await issueToken(
        db,
        {
          device: device.label,
          session: null,
          agent: null,
          harness: null,
          ttlMs: LOGIN_TTL_MS,
        },
        now,
      );
      return JSON.stringify({
        format: "forge/device-credential/1",
        id: token.id,
        token: token.token,
        device: token.device,
        expiresAt: token.expiresAt,
      });
    },
  });
  if (route === "loginpoll") {
    const code = input.device_code;
    const result =
      typeof code === "string" && DEVICE_CODE.test(code)
        ? await login.poll(code)
        : refusal("invalid_grant");
    return reply(result.ok ? 200 : (STATUS[result.error] ?? 400), result);
  }
  const device = input.device;
  if (typeof device !== "string" || !DEVICE.test(device))
    throw new ForgeFailure({
      code: "INPUT_INVALID",
      message: "device must be a short identifier",
      retry: "never",
    });
  if (address === null || address === "")
    throw new ForgeFailure({
      code: "AUTH_FORBIDDEN",
      message: "Client address is unavailable",
      retry: "never",
    });
  if (!admit(store, await sha256(address), Date.now()))
    return reply(429, refusal("rate_limited"));
  try {
    const challenge = await login.start({ label: device });
    return reply(200, {
      ok: true,
      ...challenge,
      verification_uri: "/device",
      project,
      device,
    });
  } catch (error) {
    const code =
      error instanceof DeviceLoginFailure ? error.code : "unavailable";
    return reply(STATUS[code] ?? 503, refusal(code));
  }
}
