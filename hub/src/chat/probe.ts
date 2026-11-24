import type { SlackAdapter } from "@chat-adapter/slack";
import { ChatWriteFailure, type ChatProbe } from "../contract/chat.ts";
import { slackPlatformCode, toChatWriteFailure } from "./failure.ts";

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function list(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

export function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function readSlackIdentity(adapter: SlackAdapter) {
  const auth: unknown = await adapter.webClient.auth.test({});
  const result = record(auth);
  const teamId = string(result?.team_id);
  if (result?.ok !== true || !teamId || !/^T[A-Z0-9]+$/.test(teamId))
    throw new ChatWriteFailure("unknown");
  return {
    teamId,
    userId: string(result.user_id),
    botId: string(result.bot_id),
    appId: string(result.app_id),
  };
}

export async function probeSlack(
  adapter: SlackAdapter,
  channelIds: readonly string[],
): Promise<ChatProbe> {
  try {
    const { teamId } = await readSlackIdentity(adapter);
    const channels = [];
    for (const channelId of channelIds) {
      let botIsMember = false;
      try {
        const answer: unknown = await adapter.webClient.conversations.info({
          channel: channelId,
        });
        const result = record(answer);
        const channel = record(result?.channel);
        if (
          result?.ok !== true ||
          channel?.id !== channelId ||
          typeof channel.is_member !== "boolean"
        )
          throw new ChatWriteFailure("unknown");
        botIsMember = channel.is_member;
      } catch (error) {
        if (slackPlatformCode(error) !== "channel_not_found") throw error;
      }
      channels.push({ channelId, botIsMember });
    }
    return { teamId, channels };
  } catch (error) {
    throw toChatWriteFailure(error);
  }
}
