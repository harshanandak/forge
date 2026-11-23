import type { SlackAdapter } from "@chat-adapter/slack";
import type { SummaryLookup } from "../contract/chat.ts";

export function findSummary(
  _adapter: SlackAdapter,
  _channelId: string,
  _publicationKey: string,
): Promise<SummaryLookup> {
  throw new Error("not_built");
}
