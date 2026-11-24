import { randomBytes } from "node:crypto";
import type { SlackAdapter, SlackAdapterConfig } from "@chat-adapter/slack";
import type { ChatConfig } from "chat";
import { ChatWriteFailure } from "../contract/chat.ts";
import { CHAT_DEDUPE_TTL_MS } from "../contract/chat-state.ts";
import type { ChatDeps, SecretName } from "../contract/runtime.ts";
import { validateRetryAfterResponse } from "./failure.ts";
import { createChatLogger } from "./logger.ts";
import { createSqliteChatState } from "./state.ts";

let forwardingSecret: string | undefined;

function requiredSecret(deps: ChatDeps, name: SecretName): string {
  const value: unknown = deps.secret(name);
  if (typeof value !== "string" || !value.trim())
    throw new Error("Missing " + name);
  return value;
}

export function slackWorkspace(deps: ChatDeps): string {
  const team = deps.config.slack.teamId;
  if (typeof team !== "string" || !/^T[A-Z0-9]+$/.test(team))
    throw new Error("Invalid Slack workspace");
  return team;
}

export function slackAdapterConfig(deps: ChatDeps): SlackAdapterConfig {
  slackWorkspace(deps);
  const { mode } = deps.config.slack;
  if (mode === "off") throw new Error("Slack is disabled");
  if (!deps.slackApiUrl.trim()) throw new Error("Missing Slack API URL");
  const botToken = requiredSecret(deps, "SLACK_BOT_TOKEN");
  const signingSecret =
    mode === "webhook" ? requiredSecret(deps, "SLACK_SIGNING_SECRET") : "";
  const appToken =
    mode === "socket" ? requiredSecret(deps, "SLACK_APP_TOKEN") : "";
  const logger = createChatLogger(deps.log);
  return {
    mode,
    botToken,
    signingSecret,
    appToken,
    apiUrl: deps.slackApiUrl,
    encryptionKey: "",
    socketForwardingSecret: (forwardingSecret ??=
      randomBytes(32).toString("base64url")),
    logger,
    webClientOptions: {
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
      timeout: 10_000,
      logger,
      requestInterceptor(request) {
        const data: unknown = request.data;
        if (typeof data !== "string") throw new ChatWriteFailure("refused");
        const fields = data.split("&");
        const parts = fields.filter((field) => !field.startsWith("token="));
        const form = parts.join("&");
        const body = new URLSearchParams(form);
        const url = (request.baseURL ?? "") + (request.url ?? "");
        if (
          decodeURIComponent(url).includes(botToken) ||
          [...body].some(
            ([key, value]) =>
              key.includes(botToken) || value.includes(botToken),
          )
        )
          throw new ChatWriteFailure("refused");
        request.data = form;
        const transforms = [request.transformResponse ?? []].flat();
        request.transformResponse = [validateRetryAfterResponse, ...transforms];
        return request;
      },
    },
  };
}

export function chatConfig(
  adapter: SlackAdapter,
  deps: ChatDeps,
): ChatConfig<{ slack: SlackAdapter }> {
  return {
    adapters: { slack: adapter },
    state: createSqliteChatState(deps.db),
    userName: "Forge",
    concurrency: "concurrent",
    dedupeTtlMs: CHAT_DEDUPE_TTL_MS,
    logger: createChatLogger(deps.log),
  };
}
