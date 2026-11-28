import type * as Mcp from "@modelcontextprotocol/server";
import { HOOK_PATHS } from "../contract/hooks.ts";
import { MCP_PATH } from "../contract/mcp.ts";
import type { CreateRemoteHandler, RemoteDeps } from "../contract/runtime.ts";
import { authentication, type CompareDigest } from "./auth.ts";
import { refusal } from "./responses.ts";

export { hashSecret } from "./auth.ts";
export { createDoorbell, doorbellWith } from "./doorbell.ts";
export { runAdminCommand, adminWith } from "./admin.ts";

export interface RemoteServices {
  readonly makeMcp?: typeof Mcp.createMcpHandler;
  readonly compare?: CompareDigest;
}

export const createRemoteHandler: CreateRemoteHandler = (deps) =>
  remoteWith(deps, {});

export function remoteWith(deps: RemoteDeps, services: RemoteServices) {
  const { config, core } = deps;
  const auth = authentication(core, services.compare);
  let sdk: Promise<Mcp.McpHttpHandler> | undefined;
  let hooks:
    | Promise<ReturnType<typeof import("./hook-routes.ts").hookHandler>>
    | undefined;
  let shutdown: Promise<void> | undefined;
  return {
    async handle(request: Request) {
      const path = new URL(request.url).pathname;
      const route = (
        Object.keys(HOOK_PATHS) as Array<keyof typeof HOOK_PATHS>
      ).find((name) => HOOK_PATHS[name] === path);
      if (path !== MCP_PATH && route === undefined) return refusal(404);
      const origin = request.headers.get("origin");
      if (origin !== null && !config.allowedOrigins.includes(origin))
        return refusal(403, "REQUEST_NOT_ALLOWED");
      if (shutdown) return refusal(503);
      if (route !== undefined) {
        const op = `hub.hook-${route}` as const;
        if (!config.hooks.enabled) return refusal(503, "BLOCK_DISABLED", op);
        const host = auth.host(request);
        if (!host) return refusal(401, "UNAUTHENTICATED", op);
        hooks ??= import("./hook-routes.ts").then(({ hookHandler }) =>
          hookHandler(deps),
        );
        return (await hooks)(route, request, host);
      }
      if (!config.mcp.enabled) return refusal(404);
      const caller = auth.person(request);
      if (!caller) return refusal(401, "UNAUTHENTICATED");
      if (request.method !== "POST") return refusal(405);
      sdk ??= import("./mcp.ts").then(({ mcpHandler }) =>
        mcpHandler(deps, services.makeMcp),
      );
      const clientId = caller.person.personId;
      const authInfo = {
        token: caller.tokenId,
        clientId,
        scopes: [],
        extra: { caller },
      };
      const handler = await sdk;
      const response = await handler.fetch(request, { authInfo });
      if (response.status === 413 || response.status === 415) {
        await response.body?.cancel();
        return refusal(response.status);
      }
      return response;
    },
    close() {
      shutdown ??= sdk?.then((handler) => handler.close()) ?? Promise.resolve();
      return shutdown;
    },
  };
}
