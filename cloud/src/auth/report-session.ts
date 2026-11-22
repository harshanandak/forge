import type { DeviceBrowserOptions } from "./device-browser.ts";
import { isProjectName } from "../project-name.ts";
import { appReply, SESSION_AGE } from "../report-http.ts";
import { appAsset, appPage, validIssue } from "../report-app.ts";
import { same, sha256 } from "../tokens.ts";
import { ownerPolicy } from "./compose.ts";
import { importLoginKey, type LoginEnv } from "./project-login.ts";

const ACTIVE = "__Host-forge_report";
const PENDING = "__Host-forge_report_login";
const APP = "/app/";
const LOGIN_AGE = 600;
const random = () =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const cookie = (name: string, value: string, age: number) =>
  `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`;

export type SessionOperation = "GET" | "DELETE" | number;
type Backend = Required<DeviceBrowserOptions> & {
  issuer: string;
  owner: string;
  clientId: string;
  now: () => number;
  session: (
    id: string,
    op: SessionOperation,
  ) => Promise<{ status: number; until?: number }>;
  fetchReport: (
    project: string,
    issue: string,
    until: number,
  ) => Promise<Response>;
};
type Configure = () => Backend;
export async function report(req: Request, env: LoginEnv, setup: Configure) {
  const url = new URL(req.url);
  const path = url.pathname;
  const start = path === "/app/sign-in",
    logout = path === "/app/logout";
  if (path === "/callback") {
    const states = url.searchParams.getAll("state");
    const family = (state: string) =>
      /^forge-(device|lane|report)\./.exec(state)?.[1] ??
      (state.includes(".") ? "unsupported" : "oauth");
    const families = new Set(states.map(family));
    families.delete("unsupported");
    const report = families.has("report");
    if (families.size > 1 || (report && states.length !== 1))
      return appReply(400);
    if (!report) return;
  } else if (!start && !logout && path !== APP) {
    return /^\/app(?:\/|$)/.test(path)
      ? (appAsset(path, req.method) ?? appReply(404))
      : undefined;
  }
  const method = logout ? "POST" : "GET";
  if (req.method !== method) return appReply(405, { Allow: method });
  if (logout && req.headers.get("Origin") !== url.origin) return appReply(403);

  const { FORGE_CLOUD_PROJECT: project, DEVICE_LOGIN_HMAC_KEY: secret } = env;
  if (!isProjectName(project) || typeof secret !== "string")
    return appReply(503);
  const {
    issuer,
    owner,
    clientId,
    now,
    upstream,
    redemption,
    session,
    fetchReport,
  } = setup();
  const key = await importLoginKey(secret);
  const binding = [url.origin, project, issuer, clientId, owner];
  const mac = async (name: string, data: string) => {
    const input = Buffer.from(JSON.stringify([binding, name, data]));
    const tag = await crypto.subtle.sign("HMAC", key, input);
    return Buffer.from(tag).toString("base64url");
  };
  const sign = async (name: string, data: string, age: number) =>
    cookie(name, data + "." + (await mac(name, data)), age);
  const read = async (name: string) => {
    const header = req.headers.get("Cookie") ?? "";
    const pattern = new RegExp(`(?:^|;)\\s*${name}=([^;]*)`, "g");
    const [match, duplicate] = header.matchAll(pattern);
    const value = match?.[1]?.trimEnd();
    if (duplicate || !value || value.length > 1024) return;
    const split = value.lastIndexOf(".");
    if (split <= 0) return;
    const data = value.slice(0, split);
    if (same(await mac(name, data), value.slice(split + 1))) return data;
  };

  if (start) {
    const [issue, duplicate] = url.searchParams.getAll("issue");
    if (duplicate !== undefined) return appReply(400);
    if (issue !== undefined && !validIssue(issue)) return appReply(400);
    const state = "forge-report." + random(),
      verifier = random();
    const data = [state, verifier, now() + LOGIN_AGE * 1000, issue].join("~");
    return appReply(302, {
      Location: await upstream.begin(state, verifier),
      "Set-Cookie": await sign(PENDING, data, LOGIN_AGE),
    });
  }
  if (path === "/callback") {
    const pending = (await read(PENDING)) ?? "";
    const [state, verifier, deadline, issue] = pending.split("~");
    const until = Number(deadline);
    if (!state || state !== url.searchParams.get("state") || !(now() < until))
      return appReply(401);
    const hash = await sha256("report-login:" + state);
    if (!(await redemption.claimOnce(hash, until))) return appReply(401);
    const proof = await upstream.verify(req, now(), verifier ?? "");
    if (!proof.ok) return appReply(401);
    const { identity } = proof;
    const { expiresAt, authenticatedAt } = identity;
    const at = now();
    if (at >= until || at >= expiresAt || at < authenticatedAt)
      return appReply(401);
    const auth = ownerPolicy(issuer, owner).authorize({
      principal: { kind: "person", identity },
      project,
      action: path,
      authority: "single-owner",
    });
    if (!auth.allowed) return appReply(403);
    const id = random();
    const active = await sign(ACTIVE, id, SESSION_AGE);
    const saved = await session(id, now() + SESSION_AGE * 1000);
    if (saved.status !== 204) return appReply(503);
    const query = new URLSearchParams(issue ? { issue } : {});
    const Location = issue ? APP + "?" + query.toString() : APP;
    const response = appReply(303, { Location, "Set-Cookie": active });
    response.headers.append("Set-Cookie", cookie(PENDING, "", 0));
    return response;
  }
  const id = await read(ACTIVE);
  if (logout) {
    if (id && (await session(id, "DELETE")).status !== 204)
      return appReply(503);
    const cleared = cookie(ACTIVE, "", 0);
    return appReply(303, { Location: APP, "Set-Cookie": cleared });
  }
  const live = async () => {
    if (!id) return;
    const { status, until } = await session(id, "GET");
    if (status !== 200 && status !== 401)
      throw new Error("Session unavailable");
    if (status === 200 && until !== undefined && now() < until) return until;
  };
  const until = await live();
  const [issue, duplicate] = url.searchParams.getAll("issue");
  if (issue === undefined) return appPage(until !== undefined);
  if (until === undefined) return appPage(false, 401);
  if (duplicate !== undefined || !validIssue(issue)) return appReply(400);
  const reply = await fetchReport(project, issue, until);
  if ((await live()) === until) return reply;
  void reply.body?.cancel().catch(() => undefined);
  return appPage(false, 401);
}
