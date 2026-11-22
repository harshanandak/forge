import { readOAuthConfig } from "../adapters/workers-oauth/config.ts";
import type { WorkerDependencies } from "../adapters/workers-oauth/compose.ts";
import { clerkUpstream } from "../adapters/workers-oauth/production.ts";
import { durableRedemption } from "../adapters/workers-oauth/redemption.ts";
import { record } from "../adapters/workers-oauth/report-session-store.ts";
import { isProjectName } from "../project-name.ts";
import { reportPage, appReply, SESSION_AGE } from "../report-http.ts";
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

type Dependencies = WorkerDependencies;
export async function report(req: Request, env: LoginEnv, deps: Dependencies) {
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
    if (path === "/app" || path.startsWith(APP)) return appReply(404);
    return;
  }
  const method = logout ? "POST" : "GET";
  if (req.method !== method) return appReply(405, { Allow: method });
  if (logout && req.headers.get("Origin") !== url.origin) return appReply(403);

  const cfg = readOAuthConfig(env, url.origin);
  const { FORGE_CLOUD_PROJECT: project, DEVICE_LOGIN_HMAC_KEY: secret } = env;
  const store = env.CODE_REDEMPTION as Parameters<typeof record>[0];
  const owner = cfg.ownerSubject;
  if (!owner || !isProjectName(project) || typeof secret !== "string")
    return appReply(503);
  for (const method of ["get", "idFromName"] as const)
    if (typeof store?.[method] !== "function") return appReply(503);
  const key = await importLoginKey(secret);
  const now = () => deps.clock?.now() ?? Date.now();
  const binding = [url.origin, project, cfg.issuer, cfg.clientId, owner];
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

  const clerk = clerkUpstream(cfg, deps);
  if (start) {
    const [issue, duplicate] = url.searchParams.getAll("issue");
    if (duplicate !== undefined) return appReply(400);
    const issueId = /^[a-z0-9]+(?:-[a-z0-9]+)*-\d+$/i;
    if (issue !== undefined && (issue.length > 200 || !issueId.test(issue)))
      return appReply(400);
    const state = "forge-report." + random(),
      verifier = random();
    const data = [state, verifier, now() + LOGIN_AGE * 1000, issue].join("~");
    return appReply(302, {
      Location: await clerk.begin(state, verifier),
      "Set-Cookie": await sign(PENDING, data, LOGIN_AGE),
    });
  }
  if (path === "/callback") {
    const pending = await read(PENDING);
    if (!pending) return appReply(401);
    const [state, verifier, deadline, issue] = pending.split("~");
    const until = Number(deadline);
    if (!state || state !== url.searchParams.get("state") || !(now() < until))
      return appReply(401);
    const hash = await sha256("report-login:" + state);
    if (!(await durableRedemption(store).claimOnce(hash, until)))
      return appReply(401);
    const proof = await clerk.verify(req, now(), verifier);
    if (proof.error === "unavailable" || proof.error === "timeout")
      return appReply(503);
    if (!proof.ok) return appReply(401);
    const { identity } = proof;
    const { expiresAt, authenticatedAt } = identity;
    const at = now();
    if (at >= until || at >= expiresAt || at < authenticatedAt)
      return appReply(401);
    const auth = ownerPolicy(cfg.issuer, owner).authorize({
      principal: { kind: "person", identity },
      project,
      action: path,
      authority: "single-owner",
    });
    if (!auth.allowed) return appReply(403);
    const id = random();
    const session = await sign(ACTIVE, id, SESSION_AGE);
    const saved = await record(store, id, now() + SESSION_AGE * 1000);
    if (saved !== 204) return appReply(503);
    const query = new URLSearchParams(issue ? { issue } : {});
    const target = issue ? APP + "?" + query.toString() : APP;
    const response = appReply(303, {
      Location: target,
      "Set-Cookie": session,
    });
    response.headers.append("Set-Cookie", cookie(PENDING, "", 0));
    return response;
  }
  const id = await read(ACTIVE);
  if (logout) {
    if (id && (await record(store, id, "DELETE")) !== 204) return appReply(503);
    return appReply(303, {
      Location: APP,
      "Set-Cookie": cookie(ACTIVE, "", 0),
    });
  }
  const status = id ? await record(store, id, "GET") : 401;
  if (status !== 200 && status !== 401) return appReply(503);
  return reportPage(status === 200);
}
