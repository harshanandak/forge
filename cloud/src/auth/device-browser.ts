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
  type LoginError,
} from "./device-login.ts";
import {
  browserAttempt,
  importLoginKey,
  loginConfigGap,
  loginStore,
  spend,
  type LoginEnv,
  type LoginState,
} from "./project-login.ts";

/** Every state this handler issues starts with this; no other OAuth state can (they are base64url). */
export const DEVICE_STATE_PREFIX = "forge-device.";
const COOKIE = "__Host-forge_device";
const STATE_TTL_MS = 600_000;
const MAX_PENDING_STATES = 256;
const PER_CHALLENGE = 3;
const bindName = (stateHash: string) =>
  `__Host-forge_device_${stateHash.slice(0, 24)}`;
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
/** One browser's dealings with one challenge: first a preview with two tickets, then one decision. */
interface Pending {
  cookieHash: string;
  userHash: string;
  code: string;
  expiresAt: number;
  tickets?: { approve: string; deny: string };
  decided?: {
    stateHash: string;
    bindHash: string;
    action: "approve" | "deny";
    verifier: string;
    code: string;
    expiresAt: number;
  };
}
type Held = LoginState & { browser?: Pending[] };

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
const cookieOf = (request: Request, name: string) =>
  request.headers
    .get("Cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
const noAddress = () =>
  new ForgeFailure({
    code: "AUTH_FORBIDDEN",
    message: "Client address is unavailable",
    retry: "never",
  });
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
    // A page cookie that is already well formed is kept, so a second tab does not break the first.
    const existing = cookieOf(request, COOKIE);
    const csrf =
      existing !== undefined && /^[A-Za-z0-9_-]{43}$/.test(existing)
        ? existing
        : token();
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
  // Every decision and callback is an attempt from a client address, counted before anything is checked.
  const address = request.headers.get("CF-Connecting-IP");
  if (needsClerk && (address === null || address === "")) throw noAddress();
  const login = createDeviceLogin({
    store,
    userCodeKey,
    now: () => Date.now(),
    random: (length) => crypto.getRandomValues(new Uint8Array(length)),
    issue: () => Promise.reject(new Error("Approval never issues")),
  });

  if (callback) {
    const states = url.searchParams.getAll("state");
    const stateHash = await sha256(states[0]!);
    const jar = cookieOf(request, bindName(stateHash));
    const [who, bound] = await Promise.all([
      sha256(address!),
      sha256(jar ?? ""),
    ]);
    const now = Date.now();
    // One step, no await: count the attempt, check the state, its live row and its own browser's cookie,
    // and only then use the state up. A refusal leaves every row as it was.
    const taken = store.conditionalUpdate((base) => {
      const state = base as Held;
      const row =
        states.length === 1
          ? (state.browser ?? []).find(
              (entry) =>
                entry.decided !== undefined &&
                now < entry.expiresAt &&
                same(entry.decided.stateHash, stateHash),
            )
          : undefined;
      if (!browserAttempt(db, who, row?.userHash, now)) return "limited";
      // Only the browser that was sent to Clerk holds this transaction's own cookie.
      if (row === undefined || jar === undefined) return undefined;
      if (!same(row.decided!.bindHash, bound)) return undefined;
      state.browser = state.browser!.filter(
        (entry) => entry !== row && now < entry.expiresAt,
      );
      return row.decided;
    });
    if (taken === "limited") return result(429, "rate_limited");
    if (taken === undefined) return result(400, "access_denied");
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
  const jar = cookieOf(request, COOKIE);
  if (url.pathname !== "/device") {
    // A decision needs the single-use ticket this browser was given for this action at the preview, and
    // the challenge selector it was shown with it (a budget key, never authority). It then gets its own
    // cookie, so a planted or stolen page cookie cannot finish the redirect.
    const action = url.pathname === "/device/approve" ? "approve" : "deny";
    const selector = form.get("challenge") ?? "";
    const state = DEVICE_STATE_PREFIX + token();
    const [verifier, bind] = [token(), token()];
    const [who, ticketHash, jarHash, csrfHash, stateHash, bindHash] =
      await Promise.all([
        sha256(address!),
        sha256(`${action}:${form.get("ticket") ?? ""}`),
        sha256(jar ?? ""),
        sha256(csrf ?? ""),
        sha256(state),
        sha256(bind),
      ]);
    const trusted =
      request.headers.get("Origin") === url.origin &&
      !!csrf &&
      jar !== undefined &&
      same(jarHash, csrfHash);
    const now = Date.now();
    const chosen = store.conditionalUpdate((base) => {
      const held = base as Held;
      const challenge = held.challenges.find((entry) =>
        same(entry.userHash, selector),
      );
      if (!browserAttempt(db, who, challenge?.userHash, now)) return "limited";
      const row = trusted
        ? (held.browser ?? []).find(
            (entry) =>
              entry.tickets !== undefined &&
              now < entry.expiresAt &&
              same(entry.tickets[action], ticketHash) &&
              same(entry.cookieHash, jarHash) &&
              same(entry.userHash, selector),
          )
        : undefined;
      if (row === undefined) return "refused";
      held.browser = held.browser!.filter((entry) => now < entry.expiresAt);
      delete row.tickets;
      row.expiresAt = now + STATE_TTL_MS;
      row.decided = {
        stateHash,
        bindHash,
        action,
        verifier,
        code: row.code,
        expiresAt: row.expiresAt,
      };
      return "chosen";
    });
    if (chosen === "limited") return result(429, "rate_limited");
    if (chosen !== "chosen") return result(400, "invalid_request");
    const location = await upstream!.begin(state, verifier).catch(() => {
      throw unavailable("upstream");
    });
    return new Response(null, {
      status: 302,
      headers: {
        Location: location,
        "Cache-Control": "no-store",
        "Set-Cookie": `${bindName(stateHash)}=${bind}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
      },
    });
  }
  if (
    request.headers.get("Origin") !== url.origin ||
    !csrf ||
    jar === undefined ||
    !same(await sha256(jar), await sha256(csrf))
  )
    return result(400, "invalid_request");
  const cookieHash = await sha256(jar);
  if (address === null || address === "") throw noAddress();
  const typed = (form.get("code") ?? "").trim().toUpperCase();
  const code = /^[A-Z]{8}$/.test(typed)
    ? `${typed.slice(0, 4)}-${typed.slice(4)}`
    : typed;
  const tickets = { approve: token(), deny: token() };
  // Everything that awaits comes first. The budget, the lookup and the charge for a failure then run
  // as one synchronous step, so overlapping requests cannot all pass the budget before any is charged.
  const [who, hash, approveHash, denyHash] = await Promise.all([
    sha256(address),
    USER_CODE.test(code) ? userCodeHash(userCodeKey, code) : "",
    sha256(`approve:${tickets.approve}`),
    sha256(`deny:${tickets.deny}`),
  ]);
  const now = Date.now();
  const shown = store.conditionalUpdate((base) => {
    const state = base as Held;
    if (!spend(state, who, now, "previews", false))
      return { refused: "rate_limited" };
    const challenge = state.challenges.find(
      (row) =>
        row.status === "pending" &&
        now < row.expiresAt &&
        same(row.userHash, hash),
    );
    if (challenge === undefined) {
      spend(state, who, now, "previews", true);
      return { refused: "invalid_code" };
    }
    // One record per browser and challenge, a few per challenge, and a cap for the project.
    const live = (state.browser ?? []).filter(
      (row) =>
        now < row.expiresAt &&
        !(same(row.cookieHash, cookieHash) && same(row.userHash, hash)),
    );
    const mine = live.filter((row) => same(row.userHash, hash));
    if (mine.length >= PER_CHALLENGE) live.splice(live.indexOf(mine[0]!), 1);
    state.browser = live;
    if (live.length >= MAX_PENDING_STATES) return { refused: "rate_limited" };
    live.push({
      cookieHash,
      userHash: hash,
      code,
      expiresAt: now + STATE_TTL_MS,
      tickets: { approve: approveHash, deny: denyHash },
    });
    return { device: challenge.deviceInfo.label };
  });
  if ("refused" in shown)
    return result(shown.refused === "invalid_code" ? 400 : 429, shown.refused);
  const choice = (action: "approve" | "deny") =>
    `<form method="post" action="/device/${action}"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="ticket" value="${tickets[action]}"><input type="hidden" name="challenge" value="${esc(hash)}"><button>${action === "approve" ? "Approve" : "Deny"}</button></form>`;
  return page(
    200,
    `<h1>Approve this device?</h1><p>Project <code>${esc(project)}</code></p><p>Device <code>${esc(shown.device)}</code></p>${choice("approve")}${choice("deny")}`,
  );
}
