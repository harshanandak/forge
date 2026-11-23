import type { SqlDatabase } from "../../../src/ports/store.ts";
import { sha256 } from "../tokens.ts";
import {
  type ApprovalContext,
  chooseV3Approval,
  previewV3Approval,
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

async function preview(
  context: ApprovalContext,
  form: URLSearchParams,
  cookie: string,
) {
  const cookieHash = await sha256(cookie);
  const now = Date.now();
  const id = form.get("id") ?? "";
  const row = previewV3Approval(context.db, id);
  const expiresAt = row?.expiresAt ?? now + 600_000;
  const fields = {
    approvalId: row?.id ?? id,
    cookieHash,
    expiresAt,
    issuedAt: now,
    payloadDigest: row ? approvalPayloadDigest(context.seal, row) : "",
    project: row?.project ?? context.project,
  };
  return page(
    `<h1>Promotion approval</h1><dl><dt>Project</dt><dd>${esc(row?.project ?? "")}</dd><dt>Operation</dt><dd>restore.promote</dd><dt>Activation</dt><dd>${esc(row?.activationDigest.slice(7, 19) ?? "")}</dd><dt>Device</dt><dd>${esc(row?.device ?? "")}</dd><dt>Session</dt><dd>${esc(row?.session ?? "")}</dd><dt>Expires</dt><dd>${new Date(expiresAt).toISOString()}</dd></dl>` +
      (["approve", "deny"] as const)
        .map(
          (action) =>
            `<form method="post" action="${PAGE_PATH}/${action}">${hidden("csrf", cookie)}${hidden("ticket", signTicket(context.seal, { ...fields, action, nonce: token() }))}${action === "approve" ? '<label><input type="checkbox" name="confirm" value="yes" required>Confirm promotion</label>' : ""}<button>${action}</button></form>`,
        )
        .join(""),
  );
}

async function choose(
  context: ApprovalContext,
  upstream: NonNullable<DeviceBrowserOptions["upstream"]>,
  action: TicketFields["action"],
  form: URLSearchParams,
) {
  const ticket = readTicket(form.get("ticket") ?? "");
  const state = PROMOTE_STATE_PREFIX + token();
  const bind = token();
  const verifier = token();
  const [stateHash, bindHash] = await Promise.all([
    sha256(state),
    sha256(bind),
  ]);
  const now = Date.now();
  chooseV3Approval(context, {
    ...ticket,
    action,
    stateHash,
    bindHash,
    verifier,
    createdAt: now,
    usedAt: null,
  });
  const location = await upstream.begin(state, verifier);
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
  env: LoginEnv,
  request: Request,
  url: URL,
  ports: DeviceBrowserOptions,
) {
  const context = {
    db,
    seal,
    project:
      typeof env.FORGE_CLOUD_PROJECT === "string"
        ? env.FORGE_CLOUD_PROJECT
        : "",
  };
  if (request.method === "GET") return pageForm(request, url);
  const form = new URLSearchParams(await request.text());
  const cookie = cookieOf(request, COOKIE) ?? "";
  return url.pathname === PAGE_PATH
    ? await preview(context, form, cookie)
    : await choose(
        context,
        ports.upstream!,
        url.pathname.endsWith("/approve") ? "approve" : "deny",
        form,
      );
}
