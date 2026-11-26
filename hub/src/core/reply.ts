import { ChatWriteFailure } from "../contract/chat.ts";
import type { HubCore } from "../contract/core.ts";
import type { HubError } from "../contract/errors.ts";
import { LIMITS } from "../contract/mcp.ts";
import { splitAnswer } from "./answer.ts";
import type { CoreContext } from "./core.ts";
import { fail } from "./errors.ts";
import { refused } from "./inbox.ts";
import {
  byConversation,
  conversation,
  paused,
  recordAgentPost,
} from "./thread.ts";

export function createReply(ctx: CoreContext): HubCore["reply"] {
  return async (caller, input) => {
    const { config, db, people } = ctx.deps;
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
        const project = config.projects.find(
          (entry) => entry.projectId === projectId,
        );
        if (!project) return refused("PROJECT_UNKNOWN");
        if (!sessions.isMember(project.projectId, person.personId))
          return refused("NOT_PROJECT_MEMBER");
        const channelId = project.slackChannelId;
        if (!channelId) return refused("INPUT_INVALID", "/projectId");
        if (!text.length || text.length > LIMITS.replyText)
          return refused("INPUT_INVALID", "/text");
        const error = guards.outboundText(text, "/text");
        if (error) return { ok: false, error } as const;
        const name = person.displayName;
        const label = "Forge (" + name + "'s agent)";
        return {
          ok: true,
          form: "channel",
          projectId: project.projectId,
          projectName: project.name,
          channelId,
          label,
          prefix: name + "'s agent:",
          sessionId: own.value.sessionId,
        } as const;
      }
      const existing = byConversation(db, conversationId);
      if (!existing) return refused("CONVERSATION_UNKNOWN");
      if (existing.personId !== person.personId)
        return refused("CONVERSATION_NOT_YOURS");
      if (
        existing.projectId !== undefined &&
        !sessions.isMember(existing.projectId, person.personId)
      )
        return refused("CONVERSATION_NOT_YOURS");
      if (paused(db, existing.chatThreadId))
        return refused("CONVERSATION_PAUSED");
      if (!text.length || text.length > LIMITS.replyText)
        return refused("INPUT_INVALID", "/text");
      const error = guards.outboundText(text, "/text");
      if (error) return { ok: false, error } as const;
      const name = person.displayName;
      const label = "Forge (" + name + "'s agent)";
      let prefix = name + "'s agent:";
      const latest = db
        .prepare(
          `SELECT sender_person_id FROM inbox_items
    WHERE conversation_id = ? AND kind = 'chat_message' AND delivered_at IS NOT NULL
    ORDER BY received_at DESC, rowid DESC LIMIT 1`,
        )
        .get(existing.conversationId);
      const senderId =
        typeof latest?.sender_person_id === "string"
          ? latest.sender_person_id
          : undefined;
      if (senderId !== undefined && senderId !== person.personId) {
        const asker = people.byPersonId(senderId)?.slackUserId;
        if (asker !== undefined)
          prefix = name + "'s agent, answering <@" + asker + ">:";
      }
      return {
        ok: true,
        form: "thread",
        conversation: existing,
        label,
        prefix,
        sessionId: own.value.sessionId,
      } as const;
    });
    if (!result.ok) return result;
    const parts = splitAnswer(text);
    const channelId =
      result.form === "channel"
        ? result.channelId
        : result.conversation.channelId;
    const projectName =
      result.form === "channel"
        ? result.projectName
        : (config.projects.find(
            (entry) => entry.projectId === result.conversation.projectId,
          )?.name ?? result.conversation.channelId);
    let body = text;
    if (parts.long) {
      const title =
        projectName + ": " + (parts.short.split("\n")[0] ?? parts.short);
      const link = await chat.createLongAnswer(channelId, title, text);
      body = parts.short + "\nFull answer: " + link;
    }
    const posted = result.prefix + " " + body;
    try {
      if (result.form === "channel") {
        const ref = await chat.postText(
          { kind: "channel", channelId: result.channelId },
          posted,
          { agentLabel: result.label },
        );
        const created = ctx.store.tx(() => {
          const id = ctx.store.newId("conversation");
          const row = db
            .prepare(
              `INSERT INTO conversations
    (conversation_id,project_id,person_id,session_id,adapter,chat_thread_id,channel_id,is_direct,created_by,created_at)
    VALUES (?,?,?,?,'slack',?,?,0,'agent',?) RETURNING *`,
            )
            .get(
              id,
              result.projectId,
              person.personId,
              result.sessionId,
              ref.chatThreadId,
              ref.channelId,
              ctx.deps.now(),
            );
          if (!row) throw new Error("Conversation insert returned no row");
          const next = conversation(row);
          recordAgentPost(
            ctx,
            ref,
            next,
            result.sessionId,
            person.personId,
            posted,
          );
          db.prepare(
            "UPDATE reply_owed SET answered = 1 WHERE conversation_id = ?",
          ).run(next.conversationId);
          return next;
        });
        return {
          ok: true,
          value: {
            conversationId: created.conversationId,
            chatMessageId: ref.chatMessageId,
            postedAs: result.label,
          },
        };
      }
      const ref = await chat.postText(
        { kind: "thread", chatThreadId: result.conversation.chatThreadId },
        posted,
        { agentLabel: result.label },
      );
      ctx.store.tx(() => {
        if (!result.conversation.isDirect)
          recordAgentPost(
            ctx,
            ref,
            result.conversation,
            result.sessionId,
            person.personId,
            posted,
          );
        db.prepare(
          "UPDATE reply_owed SET answered = 1 WHERE conversation_id = ?",
        ).run(result.conversation.conversationId);
      });
      return {
        ok: true,
        value: {
          conversationId: result.conversation.conversationId,
          chatMessageId: ref.chatMessageId,
          postedAs: result.label,
        },
      };
    } catch (error) {
      if (error instanceof ChatWriteFailure && error.effect === "refused")
        return {
          ok: false,
          error: { ...fail("CHAT_UNAVAILABLE"), retry: "safe" as const },
        };
      if (result.form === "channel") {
        const failure: HubError = {
          ...fail("CHAT_UNAVAILABLE"),
          repair: "Inspect that Slack thread before repeating the text.",
        };
        return { ok: false, error: failure };
      }
      const failure: HubError & { conversationId: string } = {
        ...fail("CHAT_UNAVAILABLE"),
        repair: "Inspect that Slack thread before repeating the text.",
        conversationId: result.conversation.conversationId,
      };
      return { ok: false, error: failure };
    }
  };
}
