import type { SlackAdapter } from "@chat-adapter/slack";
import type { ChatProbe } from "../contract/chat.ts";

export function probeSlack(
  _adapter: SlackAdapter,
  _channelIds: readonly string[],
): Promise<ChatProbe> {
  throw new Error("not_built");
}
