import type { SlackAdapter } from "@chat-adapter/slack";
import {
  SUMMARY_KEY_MARKER,
  SUMMARY_LOOKUP_LIMIT,
  SUMMARY_LOOKUP_MAX_PAGES,
  type ChatMessageRef,
  type SummaryLookup,
} from "../contract/chat.ts";
import { messageRef, timestamp } from "./inbound.ts";
import { list, readSlackIdentity, record } from "./probe.ts";

type SlackIdentity = Awaited<ReturnType<typeof readSlackIdentity>>;

function carriesMarker(block: unknown, marker: string): boolean {
  const elements = list(record(block)?.elements) ?? [];
  return elements.some((item) => {
    const text = record(item)?.text;
    return typeof text === "string" && text.includes(marker);
  });
}

function ownsMessage(
  message: Record<string, unknown>,
  identity: SlackIdentity,
): boolean {
  const authors = [
    [message.user, identity.userId],
    [message.bot_id, identity.botId],
  ];
  const known = authors.filter(
    ([id, expected]) => id !== undefined && expected !== undefined,
  );
  return known.length > 0 && known.every(([id, expected]) => id === expected);
}

const incomplete: SummaryLookup = { kind: "unknown" };

export async function findSummary(
  adapter: SlackAdapter,
  channelId: string,
  publicationKey: string,
): Promise<SummaryLookup> {
  const marker = SUMMARY_KEY_MARKER + publicationKey;
  let found: ChatMessageRef | undefined;
  const cursors = new Set<string>();
  let cursor: string | undefined;
  try {
    const identity = await readSlackIdentity(adapter);
    for (let page = 0; page < SUMMARY_LOOKUP_MAX_PAGES; page++) {
      const response: unknown = await adapter.webClient.conversations.history({
        channel: channelId,
        limit: SUMMARY_LOOKUP_LIMIT,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const history = record(response);
      const messages = list(history?.messages);
      const next = record(history?.response_metadata)?.next_cursor;
      if (
        history?.ok !== true ||
        !messages ||
        typeof history.has_more !== "boolean" ||
        (next !== undefined && typeof next !== "string")
      )
        return incomplete;
      for (const raw of messages) {
        const message = record(raw);
        if (!message || !timestamp(message.ts)) return incomplete;
        const blocks = list(message.blocks) ?? [];
        if (
          !(
            typeof message.text === "string" && message.text.includes(marker)
          ) &&
          !blocks.some((block) => carriesMarker(block, marker))
        )
          continue;
        const last = record(blocks.at(-1));
        const elements = list(last?.elements);
        const item = record(elements?.[0]);
        if (
          found ||
          last?.type !== "context" ||
          elements?.length !== 1 ||
          item?.type !== "mrkdwn" ||
          item.text !== marker ||
          !ownsMessage(message, identity)
        )
          return incomplete;
        found = messageRef(channelId, message.ts);
      }
      if (!history.has_more) {
        if (next) return incomplete;
        return found ? { kind: "found", ref: found } : { kind: "absent" };
      }
      if (!next || cursors.has(next)) return incomplete;
      cursors.add(next);
      cursor = next;
    }
  } catch {
    return incomplete;
  }
  return incomplete;
}
