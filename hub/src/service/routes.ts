import { SLACK_WEBHOOK_PATH, type ChatPort } from "../contract/chat.ts";
import { HOOK_PATHS } from "../contract/hooks.ts";
import { MCP_PATH } from "../contract/mcp.ts";
import type { HubConfig, HubLog, RemoteHandler } from "../contract/runtime.ts";
import { createHttpListener } from "./http.ts";

export const HEALTH_PATH = "/healthz";

export interface HubHttpDeps {
  readonly config: HubConfig;
  readonly chat?: Pick<ChatPort, "handleWebhook">;
  readonly remote?: Pick<RemoteHandler, "handle">;
  readonly log: HubLog;
}

export function createHubHttpListener({
  config,
  chat,
  remote,
  log,
}: HubHttpDeps) {
  const hooks: ReadonlySet<string> = new Set(Object.values(HOOK_PATHS));
  return createHttpListener(
    config.allowedHosts,
    (target) => {
      if (!target.startsWith(config.basePath + "/")) return;
      const stripped = target.slice(config.basePath.length);
      const path = stripped.split("?", 1)[0] ?? "";
      if (path === HEALTH_PATH)
        return {
          target: stripped,
          handle: () => Promise.resolve(new Response(null, { status: 200 })),
        };
      if (
        path === SLACK_WEBHOOK_PATH &&
        config.slack.mode === "webhook" &&
        chat
      )
        return {
          target: stripped,
          handle: (request) => chat.handleWebhook(request),
        };
      if (
        remote &&
        ((path === MCP_PATH && config.mcp.enabled) ||
          (hooks.has(path) && config.hooks.enabled))
      )
        return {
          target: stripped,
          handle: (request) => remote.handle(request),
        };
    },
    log,
  );
}
