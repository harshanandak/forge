import type { SlackAdapter } from "@chat-adapter/slack";
import type { Chat } from "chat";
import type { ChatInboundHandlers } from "../contract/chat.ts";

export function registerInboundHandlers(
  _chat: Chat<{ slack: SlackAdapter }>,
  _handlers: ChatInboundHandlers,
): void {
  throw new Error("not_built");
}
