import type { SlackAdapter, SlackAdapterConfig } from "@chat-adapter/slack";
import type { ChatConfig } from "chat";
import type { ChatDeps } from "../contract/runtime.ts";

export function slackAdapterConfig(_deps: ChatDeps): SlackAdapterConfig {
  throw new Error("not_built");
}

export function chatConfig(
  _adapter: SlackAdapter,
  _deps: ChatDeps,
): ChatConfig<{ slack: SlackAdapter }> {
  throw new Error("not_built");
}
