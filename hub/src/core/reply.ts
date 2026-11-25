import { ChatWriteFailure } from "../contract/chat.ts";
import type { HubCore } from "../contract/core.ts";
import type { HubError } from "../contract/errors.ts";
import { LIMITS } from "../contract/mcp.ts";
import type { CoreContext } from "./core.ts";
import { fail } from "./errors.ts";
import { refused } from "./inbox.ts";
import { byConversation, paused } from "./thread.ts";

export function createReply(ctx: CoreContext): HubCore["reply"] {
  return async (caller, input) => {
    const { db } = ctx.deps;
    const { guards, sessions } = ctx.store;
    const { person } = caller;
    const { sessionId, conversationId, projectId, text } = input;
    const chat = ctx.chat;
    if (!chat) return refused("BLOCK_DISABLED");
    const result = ctx.store.tx(() => {
      const own = sessions.requireOwnSession(person, sessionId);
      if (!own.ok) return own;
      if (conversationId === undefined && projectId === undefined)
        return refused("INPUT_INVALID", "/conversationId");
      if (conversationId !== undefined && projectId !== undefined)
        return refused("INPUT_INVALID", "/conversationId");
      if (conversationId === undefined) {
        if (own.value.mode !== "normal") return refused("REPLY_ONLY");
        return refused("INPUT_INVALID", "/projectId");
      }
      const conversation = byConversation(db, conversationId);
      if (!conversation) return refused("CONVERSATION_UNKNOWN");
      if (conversation.personId !== person.personId)
        return refused("CONVERSATION_NOT_YOURS");
      if (
        conversation.projectId !== undefined &&
        !sessions.isMember(conversation.projectId, person.personId)
      )
        return refused("CONVERSATION_NOT_YOURS");
      if (paused(db, conversation.chatThreadId))
        return refused("CONVERSATION_PAUSED");
      if (!text.length || text.length > LIMITS.replyText)
        return refused("INPUT_INVALID", "/text");
      const error = guards.outboundText(text, "/text");
      if (error) return { ok: false, error } as const;
      return { ok: true, conversation } as const;
    });
    if (!result.ok) return result;
    try {
      const ref = await chat.postText(
        { kind: "thread", chatThreadId: result.conversation.chatThreadId },
        text,
      );
      return {
        ok: true,
        value: {
          conversationId: result.conversation.conversationId,
          chatMessageId: ref.chatMessageId,
          postedAs: person.displayName,
        },
      };
    } catch (error) {
      if (error instanceof ChatWriteFailure && error.effect === "refused")
        return {
          ok: false,
          error: { ...fail("CHAT_UNAVAILABLE"), retry: "safe" as const },
        };
      const failure: HubError & { conversationId: string } = {
        ...fail("CHAT_UNAVAILABLE"),
        repair: "Inspect that Slack thread before repeating the text.",
        conversationId: result.conversation.conversationId,
      };
      return { ok: false, error: failure };
    }
  };
}
