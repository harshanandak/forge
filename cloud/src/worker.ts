// Routes /p/<projectId>/<route> to the Durable Object of that project. A project's claims live
// in exactly one object, so there is exactly one authority per project.
// Every request needs a bearer token. The admin routes (devices, revoke, status, dump, restore) are checked here against the
// ADMIN_TOKEN secret, before the project's object is touched; the others are checked by the object.
export { Project } from "./project.ts";
import { bearer, same, sha256, wellFormed } from "./tokens.ts";
import type { Access, AuthComposition } from "./auth/compose.ts";
import { configUnavailable, isOAuthRoute } from "./auth/compose.ts";
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

const PATH = /^\/p\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/([a-z]+)$/;
const ADMIN_ROUTES = new Set([
  "devices",
  "revoke",
  "status",
  "dump",
  "restore",
]);

// A refusal drops the request body unread, so nothing reads the stream after the response is sent.
const unauthorized = (
  request: Request,
  code: string,
  message: string,
  status = 401,
): Response => {
  void request.body?.cancel().catch(() => undefined);
  return Response.json(
    { ok: false, error: { code, message, retry: "never" } },
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
  ): Promise<Response> {
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
    if (isOAuthRoute(request))
      return auth?.route(request) ?? configUnavailable("OAUTH_COMPOSITION");
    const match = PATH.exec(new URL(request.url).pathname);
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
      } catch {
        return Response.json(
          { ok: false, error: "unavailable" },
          { status: 503, headers: { "Cache-Control": "no-store" } },
        );
      }
    }
    const presented = bearer(request);
    if (presented === undefined)
      return unauthorized(
        request,
        "AUTH_REQUIRED",
        "A bearer token is required",
      );
    if (
      ADMIN_ROUTES.has(match![2]!) &&
      !(await isAdmin(presented, env.ADMIN_TOKEN))
    )
      return unauthorized(
        request,
        "AUTH_INVALID",
        "An admin token is required",
      );
    const legacy = ADMIN_ROUTES.has(match![2]!) || wellFormed(presented);
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
    } catch {
      return unauthorized(request, "AUTH_INVALID", "Token is not valid");
    }
  },
};

export type ProjectForward = (
  request: Request,
  project: string,
  access: Access,
) => Promise<Response>;
export function createWorker(auth?: AuthComposition, forward?: ProjectForward) {
  return {
    fetch: (request: Request, env: Env) =>
      legacyWorker.fetch(request, env, auth, forward),
  };
}
export default createWorker();
