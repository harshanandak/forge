// Owner approval of a device login in the browser. The owner types the user code on /device, picks
// Approve or Deny, and signs in through Clerk. The Clerk return reaches the project object, which
// checks the proof and the owner and gives the verified identity straight to the login engine.
// Nothing here issues a token: only the polling device ever receives one.
// This file declares the narrow shape it needs from the Clerk upstream and the redemption store;
// the adapter composition (adapters/workers-oauth) supplies them.
import { ForgeFailure } from "../../../src/contract/failure.ts";
import {
  isVerifiedIdentity,
  type IdentityResult,
} from "../../../src/ports/identity.ts";
import type { SqlDatabase } from "../../../src/ports/store.ts";
import { same, sha256 } from "../tokens.ts";
import { ownerPolicy } from "./compose.ts";
import {
  createDeviceLogin,
  userCodeHash,
  type ChallengeState,
  type LoginError,
} from "./device-login.ts";
import {
  admit,
  importLoginKey,
  loginConfigGap,
  loginStore,
  type LoginEnv,
} from "./project-login.ts";

/** Every state this handler issues starts with this; no other OAuth state can (they are base64url). */
export const DEVICE_STATE_PREFIX = "forge-device.";
const COOKIE = "__Host-forge_device";
const STATE_TTL_MS = 600_000;
const MAX_PENDING_STATES = 256;
const USER_CODE = /^[BCDFGHJKLMNPQRSTVWXYZ]{4}-[BCDFGHJKLMNPQRSTVWXYZ]{4}$/;

export interface DeviceUpstream {
  begin(state: string, verifier: string): Promise<string>;
  verify(
    request: Request,
    now: number,
    verifier: string,
  ): Promise<IdentityResult & { readonly verifiedAudience?: string }>;
}
export interface DeviceBrowserOptions {
  readonly upstream?: DeviceUpstream;
  readonly redemption?: {
    claimOnce(codeHash: string, expiresAt: number): Promise<boolean>;
  };
}
interface PendingState {
  stateHash: string;
  cookieHash: string;
  code: string;
  action: "approve" | "deny";
  verifier: string;
  expiresAt: number;
}

export const isDeviceRoute = (request: Request): boolean => {
  const path = new URL(request.url).pathname;
  return request.method === "GET"
    ? path === "/device"
    : request.method === "POST" &&
        ["/device", "/device/approve", "/device/deny"].includes(path);
};
export const isDeviceCallback = (request: Request): boolean => {
  const url = new URL(request.url);
  return (
    request.method === "GET" &&
    url.pathname === "/callback" &&
    url.searchParams
      .getAll("state")
      .some((state) => state.startsWith(DEVICE_STATE_PREFIX))
  );
};

const esc = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
function page(status: number, content: string, cookie?: string): Response {
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
  });
  if (cookie !== undefined) headers.set("Set-Cookie", cookie);
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Forge device login</title>${content}</html>`,
    { status, headers },
  );
}
const result = (status: number, word: string) =>
  page(
    status,
    `<h1>Device login</h1><p><code class="result">${esc(word)}</code></p>`,
  );
const unavailable = (what: string) =>
  new ForgeFailure({
    code: "AUTH_CONFIG_UNAVAILABLE",
    message: `Device approval configuration unavailable: ${what}`,
    retry: "never",
  });
const token = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
const cookieOf = (request: Request) =>
  request.headers
    .get("Cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
const REFUSAL: Partial<Record<LoginError, number>> = {
  rate_limited: 429,
  unavailable: 503,
};

/** Serves one device browser request against the project database. The caller has checked the project is provisioned. */
export async function deviceRoute(
  db: SqlDatabase,
  env: LoginEnv,
  request: Request,
  project: string,
  options: DeviceBrowserOptions,
  body: string,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/device") {
    const csrf = token();
    return page(
      200,
      `<h1>Approve a device</h1><form method="post" action="/device"><input type="hidden" name="csrf" value="${csrf}"><label>Code <input name="code" autocomplete="off" required></label><button>Continue</button></form>`,
      `${COOKIE}=${csrf}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=900`,
    );
  }
  if (loginConfigGap(env) !== undefined) throw unavailable("login");
  const userCodeKey = await importLoginKey(
    String(env.DEVICE_LOGIN_HMAC_KEY),
  ).catch(() => {
    throw unavailable("DEVICE_LOGIN_HMAC_KEY");
  });
  const store = loginStore(db);
  const form = new URLSearchParams(body);
  const callback = isDeviceCallback(request);
  const needsClerk = callback || url.pathname !== "/device";
  if (needsClerk && env.CLERK_REDIRECT_URI !== `${url.origin}/callback`)
    throw unavailable("CLERK_REDIRECT_URI");
  const { upstream, redemption } = options;
  if (needsClerk && (upstream === undefined || redemption === undefined))
    throw unavailable("OAUTH_CONFIGURATION");
  const login = createDeviceLogin({
    store,
    userCodeKey,
    now: () => Date.now(),
    random: (length) => crypto.getRandomValues(new Uint8Array(length)),
    issue: () => Promise.reject(new Error("Approval never issues")),
  });

  if (callback) {
    const states = url.searchParams.getAll("state");
    const jar = cookieOf(request);
    const now = Date.now();
    const stateHash = await sha256(states[0]!);
    // The state is consumed first, so a replay or a wrong browser cannot try again.
    const taken = store.conditionalUpdate((base) => {
      const state = base as ChallengeState & { browser?: PendingState[] };
      state.browser = (state.browser ?? []).filter(
        (row) => now < row.expiresAt,
      );
      const at = state.browser.findIndex((row) =>
        same(row.stateHash, stateHash),
      );
      return at < 0 ? undefined : state.browser.splice(at, 1)[0];
    });
    if (
      states.length !== 1 ||
      taken === undefined ||
      jar === undefined ||
      !same(taken.cookieHash, await sha256(jar))
    )
      return result(400, "access_denied");
    // One Clerk code, one try: the durable claim comes before the proof is verified.
    const claimed = await redemption!
      .claimOnce(
        await sha256(`device-upstream:${taken.verifier}`),
        taken.expiresAt,
      )
      .catch(() => false);
    if (!claimed) return result(400, "access_denied");
    const proof = await upstream!
      .verify(request, Date.now(), taken.verifier)
      .catch(() => undefined);
    const at = Date.now();
    if (
      proof?.ok !== true ||
      !isVerifiedIdentity(proof.identity) ||
      proof.identity.audience !== env.CLERK_CLIENT_ID ||
      !(at < proof.identity.expiresAt) ||
      at < proof.identity.authenticatedAt
    )
      return result(401, "AUTH_INVALID");
    const decided = ownerPolicy(
      String(env.CLERK_ISSUER),
      String(env.FORGE_OWNER_SUBJECT),
    ).authorize({
      principal: { kind: "person", identity: proof.identity },
      project,
      action: `device.${taken.action}`,
      authority: "single-owner",
    });
    if (!decided.allowed) return result(403, "AUTH_FORBIDDEN");
    // The verified identity goes to the engine as it came, in this same execution.
    const decision = await login[taken.action](taken.code, proof.identity);
    return decision.ok
      ? result(200, taken.action === "approve" ? "approved" : "denied")
      : result(REFUSAL[decision.error] ?? 400, decision.error);
  }

  // The two POST routes below: same origin, and the cookie must match the form's proof.
  const csrf = form.get("csrf");
  const jar = cookieOf(request);
  if (
    request.headers.get("Origin") !== url.origin ||
    !csrf ||
    jar === undefined ||
    !same(await sha256(jar), await sha256(csrf))
  )
    return result(400, "invalid_request");
  const address = request.headers.get("CF-Connecting-IP");
  if (address === null || address === "")
    throw new ForgeFailure({
      code: "AUTH_FORBIDDEN",
      message: "Client address is unavailable",
      retry: "never",
    });
  const who = await sha256(address);
  const now = Date.now();
  if (!admit(store, who, now, "previews", false))
    return result(429, "rate_limited");
  const typed = (form.get("code") ?? "").trim().toUpperCase();
  const code = /^[A-Z]{8}$/.test(typed)
    ? `${typed.slice(0, 4)}-${typed.slice(4)}`
    : typed;
  const hash = USER_CODE.test(code)
    ? await userCodeHash(userCodeKey, code)
    : "";
  const device = store.conditionalUpdate(
    (state) =>
      state.challenges.find(
        (row) =>
          row.status === "pending" &&
          now < row.expiresAt &&
          same(row.userHash, hash),
      )?.deviceInfo.label,
  );
  if (device === undefined) {
    admit(store, who, now, "previews", true);
    return result(400, "invalid_code");
  }
  if (url.pathname === "/device")
    return page(
      200,
      `<h1>Approve this device?</h1><p>Project <code>${esc(project)}</code></p><p>Device <code>${esc(device)}</code></p>${(["approve", "deny"] as const).map((action) => `<form method="post" action="/device/${action}"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="code" value="${esc(code)}"><button>${action === "approve" ? "Approve" : "Deny"}</button></form>`).join("")}`,
    );
  // Approve or deny: remember the choice for this browser, then send the owner to Clerk.
  const action = url.pathname === "/device/approve" ? "approve" : "deny";
  const state = DEVICE_STATE_PREFIX + token();
  const verifier = token();
  const location = await upstream!.begin(state, verifier);
  const [stateHash, cookieHash] = [await sha256(state), await sha256(jar)];
  const saved = store.conditionalUpdate((base) => {
    const held = base as ChallengeState & { browser?: PendingState[] };
    held.browser = (held.browser ?? []).filter((row) => now < row.expiresAt);
    if (held.browser.length >= MAX_PENDING_STATES) return false;
    held.browser.push({
      stateHash,
      cookieHash,
      code,
      action,
      verifier,
      expiresAt: now + STATE_TTL_MS,
    });
    return true;
  });
  if (!saved) return result(429, "rate_limited");
  return new Response(null, {
    status: 302,
    headers: { Location: location, "Cache-Control": "no-store" },
  });
}
