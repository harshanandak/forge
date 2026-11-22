// Routes /p/<projectId>/<route> to the Durable Object of that project. A project's claims live
// in exactly one object, so there is exactly one authority per project.
// Every request needs a bearer token. The admin routes (devices, revoke, status, dump, restore) are checked here against the
// ADMIN_TOKEN secret, before the project's object is touched; the others are checked by the object.
export { Project } from "./project.ts";
import { STATUS, validateUpgrade } from "./project.ts";
import { storageResponse } from "./storage-failure.ts";
import { bearer, same, sha256, wellFormed } from "./tokens.ts";
import type { Access, AuthComposition } from "./auth/compose.ts";
import { configUnavailable, isOAuthRoute } from "./auth/compose.ts";
import {
  hasUnsupportedCallbackState,
  isDeviceCallback,
  isDeviceRoute,
} from "./auth/device-browser.ts";
import { commandProject, failed } from "./issue-commands.ts";
import { isStatePath, stateRoute } from "./state-access.ts";
import { PROJECT_NAME } from "./project-name.ts";
import {
  isLoginRoute,
  loginConfigGap,
  type LoginEnv,
} from "./auth/project-login.ts";

interface Env extends LoginEnv {
  readonly ADMIN_TOKEN?: string;
  readonly PROJECTS: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
}

const PATH = new RegExp(`^/p/(${PROJECT_NAME})/([a-z]+)$`);
const LEASE_ROUTES = new Set(["claim", "renew", "release", "holder"]);
const NOT_ADMITTED: [string, string, number] = [
  "AUTH_FORBIDDEN",
  "Commands are for a device token on the admitted project",
  403,
];
const ADMIN_ROUTES = new Set([
  "devices",
  "revoke",
  "status",
  "dump",
  "restore",
  "upgrade",
]);

export function isAdminRoute(route: string): boolean {
  return ADMIN_ROUTES.has(route);
}

// A refusal drops the request body unread, so nothing reads the stream after the response is sent.
const unauthorized = (
  request: Request,
  code: string,
  message: string,
  status = 401,
  state = false,
): Response => {
  void request.body?.cancel().catch(() => undefined);
  return Response.json(
    state
      ? failed({ code, message, retry: "never" })
      : { ok: false, error: { code, message, retry: "never" } },
    { status },
  );
};

async function isAdmin(presented: string, secret?: string): Promise<boolean> {
  if (secret === undefined || secret === "") return false;
  const [a, b] = await Promise.all([sha256(presented), sha256(secret)]);
  return same(a, b);
}

const legacyWorker = {
  async fetch(
    request: Request,
    env: Env,
    auth?: AuthComposition,
    forward?: ProjectForward,
    pilot = false,
  ): Promise<Response> {
    // Commands are for a device token on the one admitted project. Refuse everything else first:
    // before owner headers are stripped, before OAuth is read and before any object is looked up.
    const state = isStatePath(request);
    const route = stateRoute(request);
    if (state && (route === undefined || request.method !== "POST"))
      return unauthorized(
        request,
        "UNKNOWN_COMMAND",
        "No such state route",
        404,
        true,
      );
    const target = route?.project ?? commandProject(request);
    if (target !== undefined) {
      const token = bearer(request);
      const refusal: [string, string, number] | undefined =
        target !== env.FORGE_CLOUD_PROJECT ||
        request.headers.has("X-Forge-Owner") ||
        request.headers.has("X-Forge-Owner-Expires")
          ? NOT_ADMITTED
          : token === undefined
            ? ["AUTH_REQUIRED", "A bearer token is required", 401]
            : wellFormed(token)
              ? undefined
              : ["AUTH_FORBIDDEN", "Commands need a device token", 403];
      if (refusal) return unauthorized(request, ...refusal, state);
      try {
        return await env.PROJECTS.get(env.PROJECTS.idFromName(target)).fetch(
          request,
        );
      } catch (error) {
        return storageResponse(error, true, "safe", STATUS)!;
      }
    }
    // Only an authorized forward may supply this header to the private Project binding.
    if (
      request.headers.has("X-Forge-Owner") ||
      request.headers.has("X-Forge-Owner-Expires")
    ) {
      const headers = new Headers(request.headers);
      headers.delete("X-Forge-Owner");
      headers.delete("X-Forge-Owner-Expires");
      request = new Request(request, { headers });
    }
    // The owner's device pages and their Clerk return reach the one admitted project, before OAuth routing.
    const url = new URL(request.url);
    if (hasUnsupportedCallbackState(url))
      return unauthorized(
        request,
        "UNKNOWN_COMMAND",
        "No such callback route",
        404,
      );
    if (isDeviceRoute(request) || isDeviceCallback(request)) {
      const project = env.FORGE_CLOUD_PROJECT;
      const gap =
        typeof project === "string" && project !== ""
          ? loginConfigGap(env)
          : "FORGE_CLOUD_PROJECT";
      if (gap !== undefined) {
        void request.body?.cancel().catch(() => undefined);
        return configUnavailable(gap, "Device login configuration unavailable");
      }
      try {
        return await env.PROJECTS.get(
          env.PROJECTS.idFromName(String(project)),
        ).fetch(request);
      } catch (error) {
        return storageResponse(error, false, "reconcile_first", STATUS)!;
      }
    }
    if (isOAuthRoute(request))
      return auth?.route(request) ?? configUnavailable("OAUTH_COMPOSITION");
    const match = PATH.exec(url.pathname);
    const project = match?.[1];
    if (project === undefined)
      return Response.json(
        {
          ok: false,
          error: {
            code: "UNKNOWN_COMMAND",
            message: "Routes are /p/<projectId>/<route>",
            retry: "never",
          },
        },
        { status: 404 },
      );
    // Login routes are public and come before the bearer requirement. They reach the one admitted project
    // only, and only when login is configured, so no other name ever allocates an object.
    if (isLoginRoute(request)) {
      if (project !== env.FORGE_CLOUD_PROJECT)
        return unauthorized(
          request,
          "AUTH_FORBIDDEN",
          "Login is not available for this project",
          403,
        );
      const gap = loginConfigGap(env);
      if (gap !== undefined) {
        void request.body?.cancel().catch(() => undefined);
        return configUnavailable(gap, "Device login configuration unavailable");
      }
      try {
        return await env.PROJECTS.get(env.PROJECTS.idFromName(project)).fetch(
          request,
        );
      } catch (error) {
        return storageResponse(error, false, "reconcile_first", STATUS)!;
      }
    }
    const lease = LEASE_ROUTES.has(match![2]!);
    if ((pilot || lease) && project !== env.FORGE_CLOUD_PROJECT)
      return unauthorized(request, ...NOT_ADMITTED);
    const presented = bearer(request);
    if (presented === undefined)
      return unauthorized(
        request,
        "AUTH_REQUIRED",
        "A bearer token is required",
      );
    if (
      isAdminRoute(match![2]!) &&
      !(await isAdmin(presented, env.ADMIN_TOKEN))
    )
      return unauthorized(
        request,
        "AUTH_INVALID",
        "An admin token is required",
      );
    if (match![2] === "upgrade") {
      try {
        await validateUpgrade(request);
        if (request.method === "POST")
          request = new Request(request, { body: "{}" });
      } catch {
        return unauthorized(
          request,
          "INPUT_INVALID",
          "Invalid upgrade request",
          400,
        );
      }
    }
    const legacy = isAdminRoute(match![2]!) || wellFormed(presented);
    if (!legacy && auth === undefined)
      return unauthorized(request, "AUTH_INVALID", "Token is not valid");
    try {
      if (legacy)
        return await env.PROJECTS.get(env.PROJECTS.idFromName(project)).fetch(
          request,
        );
      const access = await auth!.authorize(request, project, match![2]!);
      if (!access.decision.allowed || forward === undefined)
        return unauthorized(
          request,
          access.decision.allowed ? "AUTH_FORBIDDEN" : access.decision.code,
          "Access is not allowed",
          403,
        );
      return await forward(request, project, access);
    } catch (error) {
      void request.body?.cancel().catch(() => undefined);
      const retry =
        lease || request.method === "GET" ? "safe" : "reconcile_first";
      return storageResponse(error, false, retry, STATUS)!;
    }
  },
};

export type ProjectForward = (
  request: Request,
  project: string,
  access: Access,
) => Promise<Response>;
export function createWorker(
  auth?: AuthComposition,
  forward?: ProjectForward,
  pilot = false,
) {
  return {
    fetch: (request: Request, env: Env) =>
      legacyWorker.fetch(request, env, auth, forward, pilot),
  };
}
export default createWorker(undefined, undefined, true);
