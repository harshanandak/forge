import { fail } from "../issue-read.ts";
import { digestValue } from "../../../src/core/config/pointer.ts";
import { StateOwner } from "../../../src/core/state/index.ts";
import type { SqlDatabase } from "../../../src/ports/store.ts";
import {
  LANE_APPROVALS,
  laneApprovalStatus,
  type LaneApproval,
} from "../lane-approval.ts";
import { LaneControlStore } from "../lane-control-store.ts";
import { readOnlyStore, type DurableStorage } from "../store.ts";
import { same, sha256, TOKEN_LOOKUP } from "../tokens.ts";
import { isVerifiedIdentity } from "../../../src/ports/identity.ts";
import { ownerPolicy } from "./compose.ts";
import type { DeviceBrowserOptions } from "./device-browser.ts";
import {
  importLoginKey,
  loginConfigGap,
  type LoginEnv,
} from "./project-login.ts";

export const LANE_STATE_PREFIX = "forge-lane.";
export const LANE_BROWSER = "domain_cloud_lane_browser";
export const LANE_BROWSER_MIGRATION = {
  id: "009_cloud_lane_browser",
  statements: [
    `CREATE TABLE ${LANE_BROWSER} (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL)`,
  ],
};
const SELECT = `SELECT state FROM ${LANE_APPROVALS} WHERE id=1`;
const GET = "SELECT body FROM state_records WHERE namespace=? AND key=?";
const COOKIE = "__Host-forge_lane_preview";
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const PATH = /^\/lane-approval\/([A-Za-z0-9-]{1,128})(?:\/(approve|deny))?$/;
interface Pending {
  request: string;
  action: "approve" | "deny";
  stateHash: string;
  bindHash: string;
  verifier: string;
  expiresAt: number;
}
export const isLaneCallback = (request: Request): boolean => {
  const url = new URL(request.url);
  return (
    url.pathname === "/callback" &&
    url.searchParams
      .getAll("state")
      .some((state) => state.startsWith(LANE_STATE_PREFIX))
  );
};
export const isLaneRoute = (request: Request): boolean => {
  const path = PATH.exec(new URL(request.url).pathname);
  return (
    path !== null &&
    (request.method === "GET"
      ? path[2] === undefined
      : request.method === "POST" && path[2] !== undefined)
  );
};
const esc = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
const encode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
const token = () => encode(crypto.getRandomValues(new Uint8Array(32)));
function cookieOf(request: Request): string | undefined {
  const values = (request.headers.get("Cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${COOKIE}=`));
  return values.length === 1 && SECRET.test(values[0]!.slice(COOKIE.length + 1))
    ? values[0]!.slice(COOKIE.length + 1)
    : undefined;
}
function page(
  status: number,
  content: string,
  cookie?: string,
  formAction = "'self'",
): Response {
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": `default-src 'none'; form-action ${formAction}; frame-ancestors 'none'`,
    "Referrer-Policy": "same-origin",
  });
  if (cookie !== undefined) headers.set("Set-Cookie", cookie);
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Forge lane approval</title>${content}</html>`,
    { status, headers },
  );
}
const refused = () =>
  page(
    400,
    "<h1>Lane approval unavailable</h1><p>This request cannot be used.</p>",
  );
const unavailable = () =>
  fail("AUTH_CONFIG_UNAVAILABLE", "Lane browser configuration unavailable");

/** GET uses SELECT-only storage. Only a valid POST opens the isolated browser-state table. */
export async function laneRoute(
  storage: DurableStorage,
  open: () => { db: SqlDatabase },
  env: LoginEnv,
  request: Request,
  options: DeviceBrowserOptions,
  body: string,
): Promise<Response> {
  let origin: string, clerkOrigin: string;
  try {
    const callback = new URL(String(env.CLERK_REDIRECT_URI));
    if (
      callback.protocol !== "https:" ||
      callback.pathname !== "/callback" ||
      callback.username ||
      callback.password ||
      callback.search ||
      callback.hash
    )
      throw unavailable();
    origin = callback.origin;
    clerkOrigin = new URL(String(env.CLERK_ISSUER)).origin;
    if (!/^https:\/\/[\w.:[\]-]+$/.test(clerkOrigin)) throw unavailable();
  } catch {
    throw unavailable();
  }
  if (loginConfigGap(env) !== undefined) throw unavailable();
  const path = PATH.exec(new URL(request.url).pathname);
  const db = readOnlyStore(storage, LANE_APPROVALS, [
    SELECT,
    GET,
    TOKEN_LOOKUP,
    `SELECT state FROM ${LANE_BROWSER} WHERE id=1`,
  ]);
  if (db === undefined) return refused();
  const current = (id = path?.[1]) => {
    const held = db.get(SELECT);
    const rows =
      held === undefined
        ? []
        : (JSON.parse(String(held.state)) as { requests: LaneApproval[] })
            .requests;
    const row = rows.find((entry) => entry.request === id);
    if (
      row === undefined ||
      row.project !== env.FORGE_CLOUD_PROJECT ||
      row.policyIdentity !==
        digestValue([
          env.CLERK_ISSUER,
          env.FORGE_OWNER_SUBJECT,
          env.CLERK_CLIENT_ID,
        ])
    )
      return;
    const control = new LaneControlStore(
      new StateOwner(db, { now: () => Date.now() }),
      row.project,
    ).read("id" in row.scope ? row.scope.id : undefined);
    const requester = db.get(TOKEN_LOOKUP, [row.token]);
    if (
      !control.ok ||
      laneApprovalStatus(row, control.result, Date.now()) !== "pending" ||
      requester === undefined ||
      requester.revoked_at !== null ||
      !(Number(requester.expires_at) > Date.now()) ||
      requester.device !== row.device ||
      requester.session !== row.session
    )
      return;
    return { row, control: control.result };
  };
  if (isLaneCallback(request)) {
    const url = new URL(request.url),
      states = url.searchParams.getAll("state"),
      codes = url.searchParams.getAll("code");
    if (
      request.method !== "GET" ||
      url.origin !== origin ||
      url.hash ||
      states.length !== 1 ||
      !new RegExp(
        `^${LANE_STATE_PREFIX.replace(".", "\\.")}[A-Za-z0-9_-]{43}$`,
      ).test(states[0]!) ||
      codes.length !== 1 ||
      !codes[0] ||
      codes[0].length > 16_384 ||
      url.searchParams.has("error")
    )
      return refused();
    const { upstream, redemption } = options;
    if (upstream === undefined || redemption === undefined) throw unavailable();
    const stateHash = await sha256(states[0]!);
    const readStates = (source: SqlDatabase) => {
      const held = source.get(`SELECT state FROM ${LANE_BROWSER} WHERE id=1`);
      return held === undefined
        ? []
        : (JSON.parse(String(held.state)) as Pending[]);
    };
    const pending = readStates(db).find((entry) =>
      same(entry.stateHash, stateHash),
    );
    const row =
      pending === undefined ? undefined : current(pending.request)?.row;
    if (
      pending === undefined ||
      row === undefined ||
      !(Date.now() < pending.expiresAt)
    )
      return refused();
    const fresh = () => {
      const live = current(row.request);
      return (
        live !== undefined &&
        Date.now() < pending.expiresAt &&
        digestValue(live.row) === digestValue(row)
      );
    };
    const name = `__Host-forge_lane_${stateHash.slice(0, 24)}`;
    const cookies = (request.headers.get("Cookie") ?? "")
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.startsWith(`${name}=`));
    const bind = cookies.length === 1 ? cookies[0]!.slice(name.length + 1) : "";
    if (!SECRET.test(bind)) return refused();
    const bindHash = await sha256(bind);
    if (!fresh() || !same(bindHash, pending.bindHash)) return refused();
    const writable = open().db;
    // Consume only this browser's state before any exchange. Concurrent callbacks cannot both take it.
    const taken = writable.transaction(() => {
      const live = readStates(writable);
      const index = live.findIndex(
        (entry) => digestValue(entry) === digestValue(pending),
      );
      if (index < 0 || !fresh()) return false;
      live.splice(index, 1);
      writable.run(`UPDATE ${LANE_BROWSER} SET state=? WHERE id=1`, [
        JSON.stringify(live),
      ]);
      return true;
    });
    if (!taken) return refused();
    const codeHash = await sha256(`lane-upstream:${codes[0]}`);
    if (!fresh()) return refused();
    const claimed = await redemption
      .claimOnce(codeHash, pending.expiresAt)
      .catch(() => false);
    if (!fresh() || !claimed) return refused();
    const proof = await upstream
      .verify(request, Date.now(), pending.verifier)
      .catch(() => undefined);
    if (!fresh() || proof?.ok !== true || !isVerifiedIdentity(proof.identity))
      return refused();
    // Same StateOwner-backed database and synchronous transaction as request creation. No await after this recheck.
    const recorded = writable.transaction(() => {
      const at = Date.now();
      if (
        !fresh() ||
        proof.identity.audience !== env.CLERK_CLIENT_ID ||
        !(at < proof.identity.expiresAt) ||
        at < proof.identity.authenticatedAt ||
        !ownerPolicy(
          String(env.CLERK_ISSUER),
          String(env.FORGE_OWNER_SUBJECT),
        ).authorize({
          principal: { kind: "person", identity: proof.identity },
          project: row.project,
          action: `lane.${pending.action}`,
          authority: "single-owner",
        }).allowed
      )
        return false;
      const held = writable.get(SELECT)!;
      const state = JSON.parse(String(held.state)) as {
        requests: LaneApproval[];
      };
      state.requests = state.requests.map((entry) =>
        entry.request === row.request
          ? {
              ...entry,
              status: pending.action === "approve" ? "approved" : "denied",
              decision: {
                issuer: proof.identity.issuer,
                subject: proof.identity.subject,
                at: new Date(at).toISOString(),
              },
            }
          : entry,
      );
      writable.run(`UPDATE ${LANE_APPROVALS} SET state=? WHERE id=1`, [
        JSON.stringify(state),
      ]);
      return true;
    });
    return recorded
      ? page(
          200,
          `<h1>Lane approval</h1><p>${pending.action === "approve" ? "approved" : "denied"}</p>`,
        )
      : refused();
  }
  if (path === null) return refused();
  const shown = current();
  if (shown === undefined) return refused();
  const { row, control } = shown;
  const fresh = () => {
    const live = current();
    return live !== undefined && digestValue(live.row) === digestValue(row);
  };
  const jar = cookieOf(request);
  const browser = jar ?? token();
  const key = await importLoginKey(String(env.DEVICE_LOGIN_HMAC_KEY)).catch(
    () => {
      throw unavailable();
    },
  );
  // Signed, cookie-bound tickets keep preview read-only; redemption happens only on POST.
  const ticketFor = async (action: string, nonce = token()) => {
    const mac = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(
        JSON.stringify([`lane.${action}`, row, browser, nonce]),
      ),
    );
    return `${nonce}.${encode(new Uint8Array(mac))}`;
  };
  if (request.method === "GET") {
    const tickets = await Promise.all([
      ticketFor("approve"),
      ticketFor("deny"),
    ]);
    if (!fresh()) return refused();
    const choice = (action: string, ticket: string) =>
      `<form method="post" action="${origin}/lane-approval/${esc(row.request)}/${action}"><input type="hidden" name="ticket" value="${ticket}"><button>${action === "approve" ? "Approve" : "Deny"}</button></form>`;
    const scope = "id" in row.scope ? row.scope.id : "ALL LANES";
    return page(
      200,
      `<h1>Lane approval</h1><p>Project: ${esc(row.project)}</p><p>Affected scope: ${esc(scope)}</p><p>Current stop: ${esc(control.scope ?? "individual lanes")}; epoch ${control.epoch}; ${esc(control.since ?? "")}</p><p>Expiry: ${esc(row.expiresAt)}</p>${choice("approve", tickets[0])}${choice("deny", tickets[1])}`,
      `${COOKIE}=${browser}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
      `'self' ${clerkOrigin}`,
    );
  }
  const action = path[2];
  const form = new URLSearchParams(body);
  const ticket = (form.get("ticket") ?? "").split(".");
  if (
    (action !== "approve" && action !== "deny") ||
    request.headers.get("Origin") !== origin ||
    request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/x-www-form-urlencoded" ||
    jar === undefined ||
    [...form.keys()].length !== 1 ||
    form.getAll("ticket").length !== 1 ||
    ticket.length !== 2 ||
    !ticket.every((part) => SECRET.test(part))
  )
    return refused();
  const expected = await ticketFor(action, ticket[0]);
  if (!same(expected, form.get("ticket")!) || !fresh()) return refused();
  const { upstream, redemption } = options;
  if (upstream === undefined || redemption === undefined) throw unavailable();
  const expiresAt = Date.parse(row.expiresAt);
  const ticketHash = await sha256(`lane-ticket:${action}:${expected}`);
  if (!fresh()) return refused();
  if (
    !(await redemption.claimOnce(ticketHash, expiresAt).catch(() => false)) ||
    !fresh()
  )
    return refused();
  const state = LANE_STATE_PREFIX + token(),
    verifier = token(),
    bind = token();
  const [stateHash, bindHash] = await Promise.all([
    sha256(state),
    sha256(bind),
  ]);
  if (!fresh()) return refused();
  const location = await upstream.begin(state, verifier).catch(() => {
    throw unavailable();
  });
  if (!fresh()) return refused();
  const writable = open().db;
  const saved = writable.transaction(() => {
    if (!fresh()) return false;
    const before = writable.get(`SELECT state FROM ${LANE_BROWSER} WHERE id=1`);
    const pending =
      before === undefined
        ? []
        : (JSON.parse(String(before.state)) as Pending[]);
    const live = pending.filter(
      (entry) =>
        Date.now() < entry.expiresAt &&
        !(entry.request === row.request && entry.action === action),
    );
    if (live.length >= 256) return false;
    live.push({
      request: row.request,
      action,
      stateHash,
      bindHash,
      verifier,
      expiresAt,
    });
    writable.run(
      `INSERT INTO ${LANE_BROWSER} (id, state) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET state=excluded.state`,
      [JSON.stringify(live)],
    );
    return true;
  });
  if (!saved) return refused();
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      "Cache-Control": "no-store",
      "Set-Cookie": `__Host-forge_lane_${stateHash.slice(0, 24)}=${bind}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
    },
  });
}
