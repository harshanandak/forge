import { digestValue } from "../../../src/core/config/pointer.ts";
import type { SqlDatabase } from "../../../src/ports/store.ts";
import { same, sha256 } from "../tokens.ts";
import {
  type ApprovalContext,
  chooseV3Approval,
  invalidBrowser,
  liveApproval,
} from "../v3-approvals.ts";
import {
  approvalIdPattern,
  approvalPayloadDigest,
  browserTokenPattern,
  readTicket,
  type Seal,
  signTicket,
  type TicketFields,
} from "../v3-seal.ts";
import { fail, readV3Root, type V3Image } from "../v3-store.ts";
import type { DeviceBrowserOptions } from "./device-browser.ts";
import type { LoginEnv } from "./project-login.ts";

const PROMOTE_STATE_PREFIX = "forge-promote.";
const PAGE_PATH = "/promote-approval";
const COOKIE = "__Host-forge_promote";
const COOKIE_FLAGS = "Path=/; Secure; HttpOnly; SameSite=Lax";
const bindName = (hash: string) => `${COOKIE}_${hash.slice(0, 24)}`;
const token = () =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

export const isPromoteRoute = (request: Request, url: URL) =>
  (url.pathname === PAGE_PATH &&
    (request.method === "GET" || request.method === "POST")) ||
  (request.method === "POST" &&
    (url.pathname === `${PAGE_PATH}/approve` ||
      url.pathname === `${PAGE_PATH}/deny`));

const esc = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const cookieOf = (request: Request, name: string) =>
  request.headers
    .get("Cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);

function page(content: string, cookie?: string): Response {
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    "Referrer-Policy": "same-origin",
  });
  if (cookie !== undefined) headers.set("Set-Cookie", cookie);
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Forge promotion approval</title>${content}</html>`,
    { headers },
  );
}

const hidden = (name: string, value: string) =>
  `<input type="hidden" name="${name}" value="${esc(value)}">`;
const once = (params: URLSearchParams, key: string) => {
  const values = params.getAll(key);
  return values.length === 1 ? values[0] : undefined;
};

function promoteConfig(env: LoginEnv, url: URL, ports: DeviceBrowserOptions) {
  const {
    CLERK_ISSUER,
    FORGE_OWNER_SUBJECT,
    CLERK_CLIENT_ID,
    CLERK_REDIRECT_URI,
  } = env;
  const { upstream, redemption } = ports;
  if (
    typeof CLERK_ISSUER !== "string" ||
    !CLERK_ISSUER ||
    typeof FORGE_OWNER_SUBJECT !== "string" ||
    !FORGE_OWNER_SUBJECT ||
    typeof CLERK_CLIENT_ID !== "string" ||
    !CLERK_CLIENT_ID ||
    CLERK_REDIRECT_URI !== `${url.origin}/callback` ||
    !upstream ||
    !redemption
  )
    throw fail(
      "AUTH_CONFIG_UNAVAILABLE",
      "Promotion approval configuration is unavailable",
    );
  return { upstream, redemption };
}

function pageForm(request: Request, url: URL) {
  const existing = cookieOf(request, COOKIE);
  const keep = existing !== undefined && browserTokenPattern.test(existing);
  const csrf = keep ? existing : token();
  const id = once(url.searchParams, "id") ?? "";
  return page(
    `<h1>Promotion approval</h1><form method="post" action="${PAGE_PATH}">${hidden("csrf", csrf)}${hidden("id", approvalIdPattern.test(id) ? id : "")}<button>Continue</button></form>`,
    keep ? undefined : `${COOKIE}=${csrf}; ${COOKIE_FLAGS}; Max-Age=900`,
  );
}

function checkedForm(request: Request, url: URL, body: string) {
  const form = new URLSearchParams(body);
  const csrf = once(form, "csrf");
  const cookie = cookieOf(request, COOKIE);
  if (
    request.headers.get("Origin") !== url.origin ||
    cookie === undefined ||
    !browserTokenPattern.test(cookie) ||
    csrf === undefined ||
    !same(csrf, cookie)
  )
    throw invalidBrowser();
  return { form, cookie };
}

async function preview(
  context: ApprovalContext,
  form: URLSearchParams,
  cookie: string,
) {
  const id = once(form, "id");
  if (id === undefined || !approvalIdPattern.test(id))
    throw fail("INPUT_INVALID", "Expected a promotion approval id");
  const cookieHash = await sha256(cookie);
  const now = Date.now();
  const row = liveApproval(context, id, now);
  const fields = {
    approvalId: row.id,
    cookieHash,
    expiresAt: row.expiresAt,
    issuedAt: now,
    payloadDigest: approvalPayloadDigest(context.seal, row),
    project: row.project,
  };
  return page(
    `<h1>Promotion approval</h1><dl><dt>Project</dt><dd>${esc(row.project)}</dd><dt>Operation</dt><dd>restore.promote</dd><dt>Activation</dt><dd>${esc(row.activationDigest.slice(7, 19))}</dd><dt>Device</dt><dd>${esc(row.device)}</dd><dt>Session</dt><dd>${esc(row.session)}</dd><dt>Expires</dt><dd>${new Date(row.expiresAt).toISOString()}</dd></dl>` +
      (["approve", "deny"] as const)
        .map(
          (action) =>
            `<form method="post" action="${PAGE_PATH}/${action}">${hidden("csrf", cookie)}${hidden("ticket", signTicket(context.seal, { ...fields, action, nonce: token() }))}${action === "approve" ? '<label><input type="checkbox" name="confirm" value="yes" required>Confirm promotion</label>' : ""}<button>${action}</button></form>`,
        )
        .join(""),
  );
}

type PromotePorts = ReturnType<typeof promoteConfig>;
const unavailable = () =>
  fail("UNAVAILABLE", "Promotion approval temporarily unavailable");

async function choose(
  context: ApprovalContext,
  upstream: PromotePorts["upstream"],
  action: TicketFields["action"],
  form: URLSearchParams,
  cookie: string,
) {
  if (action === "approve" && once(form, "confirm") !== "yes")
    throw invalidBrowser();
  const input = once(form, "ticket");
  const ticket =
    input === undefined ? undefined : readTicket(context.seal, input);
  if (!ticket || ticket.action !== action || ticket.project !== context.project)
    throw invalidBrowser();
  const state = PROMOTE_STATE_PREFIX + token();
  const bind = token();
  const verifier = token();
  const [stateHash, bindHash, cookieHash] = await Promise.all([
    sha256(state),
    sha256(bind),
    sha256(cookie),
  ]);
  const now = Date.now();
  if (!same(ticket.cookieHash, cookieHash) || now >= ticket.expiresAt)
    throw invalidBrowser();
  chooseV3Approval(context, {
    ...ticket,
    stateHash,
    bindHash,
    verifier,
    createdAt: now,
    usedAt: null,
  });
  let location: string;
  try {
    location = await upstream.begin(state, verifier);
  } catch {
    throw unavailable();
  }
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      "Cache-Control": "no-store",
      "Set-Cookie": `${bindName(stateHash)}=${bind}; ${COOKIE_FLAGS}; Max-Age=600`,
    },
  });
}

export async function promoteRoute(
  db: SqlDatabase,
  seal: Seal,
  image: () => V3Image,
  env: LoginEnv,
  request: Request,
  url: URL,
  ports: DeviceBrowserOptions,
  readBody: () => Promise<string>,
) {
  if (readV3Root(db, seal).activationDigest === undefined)
    throw fail(
      "INPUT_CONFLICT",
      "The restored project is not awaiting promotion",
    );
  const configured = promoteConfig(env, url, ports);
  const context = {
    db,
    seal,
    image,
    project:
      typeof env.FORGE_CLOUD_PROJECT === "string"
        ? env.FORGE_CLOUD_PROJECT
        : "",
    policyIdentity: () =>
      digestValue([
        env.CLERK_ISSUER,
        env.FORGE_OWNER_SUBJECT,
        env.CLERK_CLIENT_ID,
      ]),
  };
  if (request.method === "GET") return pageForm(request, url);
  const { form, cookie } = checkedForm(request, url, await readBody());
  return url.pathname === PAGE_PATH
    ? await preview(context, form, cookie)
    : await choose(
        context,
        configured.upstream,
        url.pathname.endsWith("/approve") ? "approve" : "deny",
        form,
        cookie,
      );
}
