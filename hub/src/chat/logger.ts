import type { SlackAdapterConfig } from "@chat-adapter/slack";
import type { Logger } from "chat";
import type { HubLog } from "../contract/runtime.ts";

type WebClientOptions = NonNullable<SlackAdapterConfig["webClientOptions"]>;
type WebClientLogger = NonNullable<WebClientOptions["logger"]>;

export function createChatLogger(_log: HubLog): Logger & WebClientLogger {
  throw new Error("not_built");
}
