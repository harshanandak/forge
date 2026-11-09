// Routes /p/<projectId>/<route> to the Durable Object of that project. A project's claims live
// in exactly one object, so there is exactly one authority per project.
export { Project } from "./project.ts";

interface Env {
  readonly PROJECTS: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
}

const PATH = /^\/p\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/[a-z]+$/;

export default {
  fetch(request: Request, env: Env): Promise<Response> | Response {
    const project = PATH.exec(new URL(request.url).pathname)?.[1];
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
    return env.PROJECTS.get(env.PROJECTS.idFromName(project)).fetch(request);
  },
};
