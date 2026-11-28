import { ChatWriteFailure, type ChatPostTarget } from "../contract/chat.ts";
import type { ChatMessageRef } from "../contract/chat.ts";
import type { HubCore } from "../contract/core.ts";
import type { Conversation } from "../contract/domain.ts";
import { redactSecretText, type HubError } from "../contract/errors.ts";
import { LIMITS } from "../contract/mcp.ts";
import {
  recoverAgentPosts,
  reserveAgentPost,
  settleAgentPost,
} from "./agent-posts.ts";
import { fitSection, splitAnswer } from "./answer.ts";
import type { CoreContext } from "./core.ts";
import { fail } from "./errors.ts";
import { refused } from "./inbox.ts";
import {
  byConversation,
  channelBindingRefusal,
  conversation,
  enterThread,
  paused,
  postLoopPause,
  recordAgentPost,
  str,
} from "./thread.ts";

export interface AgentPostInput {
  readonly target: ChatPostTarget;
  readonly channelId: string;
  readonly projectName: string;
  readonly label: string;
  readonly prefix: string;
  readonly text: string;
  readonly fallbackName: string;
  readonly conversation?: Conversation;
  readonly sessionId?: string;
  readonly personId?: string;
}

export async function postAgentText(ctx: CoreContext, input: AgentPostInput) {
  if (!ctx.chat) throw new ChatWriteFailure("refused");
  const parts = splitAnswer(input.text);
  let body = input.text;
  if (parts.long) {
    const title =
      input.projectName + ": " + (parts.short.split("\n")[0] ?? parts.short);
    try {
      const link = await ctx.chat.createLongAnswer(
        input.channelId,
        title,
        input.text,
      );
      body = parts.short + "\nFull answer: " + link;
    } catch (error) {
      if (error instanceof ChatWriteFailure && error.effect === "refused") {
        ctx.deps.log.warn("canvas_fallback", {
          reason: error.reason ?? "unknown",
        });
        body =
          parts.short +
          " (The full answer could not be posted as a canvas. Ask " +
          input.fallbackName +
          "'s agent for the detail.)";
      } else throw error;
    }
  }
  const posted = fitSection(input.prefix + " ", body);
  const { conversation, sessionId, personId } = input;
  const reservation =
    conversation && sessionId && personId
      ? reserveAgentPost(ctx, conversation, sessionId, personId, posted)
      : undefined;
  let ref: ChatMessageRef;
  try {
    ref = await ctx.chat.postText(input.target, posted, {
      agentLabel: input.label,
    });
  } catch (error) {
    if (reservation) {
      const refused =
        error instanceof ChatWriteFailure && error.effect === "refused";
      const projected = settleAgentPost(ctx, reservation, {
        phase: refused ? "refused" : "unknown",
      });
      if (projected && !refused)
        await postLoopPause(ctx, reservation.conversation);
    }
    throw error;
  }
  const projected =
    reservation &&
    settleAgentPost(ctx, reservation, { phase: "confirmed", ref });
  return { ref, text: posted, projected };
}

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
        const name = redactSecretText(person.displayName);
        const label = "Forge (" + name + "'s agent)";
        return {
          ok: true,
          form: "channel",
          projectId: project.projectId,
          projectName: project.name,
          channelId,
          name,
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
      const binding = channelBindingRefusal(db, existing, existing.projectId);
      if (binding) return binding;
      if (!text.length || text.length > LIMITS.replyText)
        return refused("INPUT_INVALID", "/text");
      const error = guards.outboundText(text, "/text");
      if (error) return { ok: false, error } as const;
      const name = redactSecretText(person.displayName);
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
      const owedCandidates = db
        .prepare(
          `SELECT item_id FROM reply_owed
    WHERE conversation_id = ?`,
        )
        .all(existing.conversationId)
        .map((row) => str(row.item_id));
      return {
        ok: true,
        form: "thread",
        conversation: existing,
        name,
        label,
        prefix,
        owedCandidates,
        sessionId: own.value.sessionId,
      } as const;
    });
    if (!result.ok) return result;
    let releaseThread: (() => void) | undefined;
    try {
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
      const postInput = {
        channelId,
        projectName,
        label: result.label,
        prefix: result.prefix,
        text,
        fallbackName: result.name,
      };
      if (result.form === "channel") {
        const posted = await postAgentText(ctx, {
          ...postInput,
          target: { kind: "channel", channelId: result.channelId },
        });
        const ref = posted.ref;
        const created = ctx.store.tx(() => {
          const id = ctx.store.newId("conversation");
          const row = db
            .prepare(
              `INSERT INTO conversations
    (conversation_id,project_id,person_id,session_id,adapter,chat_thread_id,channel_id,is_direct,created_by,created_at)
    VALUES (?,?,?,?,'slack',?,?,0,'agent',?) ON CONFLICT(adapter, chat_thread_id, person_id) DO NOTHING RETURNING *`,
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
          if (row) {
            const next = conversation(row);
            recordAgentPost(
              ctx,
              ref,
              next,
              result.sessionId,
              person.personId,
              posted.text,
            );
            db.prepare(
              "UPDATE reply_owed SET answered = 1 WHERE conversation_id = ?",
            ).run(next.conversationId);
            return next;
          }
          db.prepare(
            "UPDATE conversations SET session_id = ? WHERE adapter = 'slack' AND chat_thread_id = ? AND person_id = ? AND session_id IS NULL",
          ).run(result.sessionId, ref.chatThreadId, person.personId);
          const found = db
            .prepare(
              `SELECT * FROM conversations WHERE adapter = 'slack' AND chat_thread_id = ? AND person_id = ?`,
            )
            .get(ref.chatThreadId, person.personId);
          if (!found)
            throw new Error("Adopted conversation missing after conflict");
          const next = conversation(found);
          recordAgentPost(
            ctx,
            ref,
            next,
            result.sessionId,
            person.personId,
            posted.text,
          );
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
      const conv = result.conversation;
      releaseThread = await enterThread(ctx, conv.chatThreadId);
      const ready = ctx.store.tx(() => {
        const fresh = byConversation(db, conv.conversationId);
        if (!fresh) return refused("CONVERSATION_UNKNOWN");
        const binding = channelBindingRefusal(db, fresh, fresh.projectId);
        if (binding) return binding;
        const owed = db
          .prepare(
            `SELECT item_id FROM reply_owed WHERE answered = 0
             AND item_id IN (SELECT value FROM json_each(?))`,
          )
          .all(JSON.stringify(result.owedCandidates))
          .map((row) => str(row.item_id));
        return { ok: true, owed } as const;
      });
      if (!ready.ok) return ready;
      if (!conv.isDirect) recoverAgentPosts(ctx, conv.chatThreadId);
      if (paused(db, conv.chatThreadId)) {
        await postLoopPause(ctx, conv);
        return refused("CONVERSATION_PAUSED");
      }
      const posted = await postAgentText(ctx, {
        ...postInput,
        target: { kind: "thread", chatThreadId: conv.chatThreadId },
        conversation: conv,
        sessionId: result.sessionId,
        personId: person.personId,
      });
      ctx.store.tx(() => {
        if (ready.owed.length > 0)
          db.prepare(
            "UPDATE reply_owed SET answered = 1 WHERE item_id IN (" +
              ready.owed.map(() => "?").join(",") +
              ")",
          ).run(...ready.owed);
      });
      if (posted.projected) await postLoopPause(ctx, conv);
      return {
        ok: true,
        value: {
          conversationId: result.conversation.conversationId,
          chatMessageId: posted.ref.chatMessageId,
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
    } finally {
      releaseThread?.();
    }
  };
}
