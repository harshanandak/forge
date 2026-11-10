// Routes /p/<projectId>/<route> to the Durable Object of that project. A project's claims live
// in exactly one object, so there is exactly one authority per project.
// Every request needs a bearer token. The admin routes (devices, revoke, status, dump, restore) are checked here against the
// ADMIN_TOKEN secret, before the project's object is touched; the others are checked by the object.
export { Project } from "./project.ts";
import { bearer, same, sha256, wellFormed } from "./tokens.ts";
import type { Access, AuthComposition } from "./auth/compose.ts";

interface Env {
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
): Response => {
  void request.body?.cancel().catch(() => undefined);
  return Response.json(
    { ok: false, error: { code, message, retry: "never" } },
    { status: 401 },
  );
};

async function isAdmin(presented: string, secret?: string): Promise<boolean> {
  if (secret === undefined || secret === "") return false;
  const [a, b] = await Promise.all([sha256(presented), sha256(secret)]);
  return same(a, b);
}

const legacyWorker = {
  async fetch(request: Request, env: Env): Promise<Response> {
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
    if (!ADMIN_ROUTES.has(match![2]!) && !wellFormed(presented))
      return unauthorized(request, "AUTH_INVALID", "Token is not valid");
    return env.PROJECTS.get(env.PROJECTS.idFromName(project)).fetch(request);
  },
};

export type ProjectForward = (
  request: Request,
  project: string,
  access: Access,
) => Promise<Response>;
export function createWorker(
  _auth?: AuthComposition,
  _forward?: ProjectForward,
) {
  return legacyWorker;
}
export default legacyWorker;
