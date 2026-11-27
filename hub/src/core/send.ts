import { ChatWriteFailure } from "../contract/chat.ts";
import type { HubCore } from "../contract/core.ts";
import { LIMITS } from "../contract/mcp.ts";
import type { CoreContext } from "./core.ts";
import { refused } from "./inbox.ts";
import { postAgentText } from "./reply.ts";
import { frontSession, insertItem } from "./routing.ts";
import {
  byConversation,
  enterThread,
  paused,
  postLoopPause,
  recordAgentPost,
} from "./thread.ts";

export function createSend(ctx: CoreContext): HubCore["send"] {
  return async (caller, input) => {
    const { config, db, people } = ctx.deps;
    const { guards, sessions } = ctx.store;
    const { person } = caller;
    const {
      projectId,
      toPersonId,
      sessionId,
      targetSessionId,
      conversationId,
      text,
    } = input;
    const result = ctx.store.tx(() => {
      const own = sessions.requireOwnSession(person, sessionId);
      if (!own.ok) return own;
      if (!config.projects.some((p) => p.projectId === projectId))
        return refused("PROJECT_UNKNOWN");
      const owner = people.byPersonId(toPersonId);
      if (!owner) return refused("PERSON_UNKNOWN");
      if (
        !sessions.isMember(projectId, person.personId) ||
        !sessions.isMember(projectId, owner.personId)
      )
        return refused("NOT_PROJECT_MEMBER");
      const chat =
        conversationId === undefined
          ? undefined
          : byConversation(db, conversationId);
      if (conversationId !== undefined) {
        if (!chat) return refused("CONVERSATION_UNKNOWN");
        if (chat.personId !== person.personId)
          return refused("CONVERSATION_NOT_YOURS");
        const currentChannel = config.projects.find(
          (entry) => entry.projectId === projectId,
        )?.slackChannelId;
        if (
          !chat.isDirect &&
          (chat.projectId !== projectId || chat.channelId !== currentChannel)
        )
          return refused("INPUT_INVALID", "/conversationId");
        if (paused(db, chat.chatThreadId))
          return refused("CONVERSATION_PAUSED");
      }
      if (!text.length || text.length > LIMITS.sendText)
        return refused("INPUT_INVALID", "/text");
      const error = guards.outboundText(text, "/text");
      if (error) return { ok: false, error } as const;
      const target =
        targetSessionId === undefined
          ? frontSession(ctx, owner.personId, projectId)
          : sessions.session(targetSessionId);
      if (
        targetSessionId !== undefined &&
        (!target ||
          target.personId !== owner.personId ||
          (target.projectId !== undefined && target.projectId !== projectId))
      )
        return refused("SESSION_UNKNOWN");
      return { ok: true, owner, target, chat } as const;
    });
    if (!result.ok) return result;
    const storeItem = () =>
      ctx.store.tx(() =>
        insertItem(ctx, {
          owner: result.owner,
          sender: person,
          agent: sessionId,
          projectId,
          target: result.target,
          text: guards.storedText(text),
        }),
      );
    const deliver = async (item: ReturnType<typeof storeItem>) => {
      await ctx.notify({
        person: result.owner,
        projectId,
        items: [item.id],
        answers: [],
        ...(item.session === undefined ? {} : { session: item.session }),
      });
    };
    const chat = result.chat;
    if (!chat || chat.isDirect) {
      const item = storeItem();
      await deliver(item);
      return { ok: true, value: { itemId: item.id } };
    }
    const release = await enterThread(ctx, chat.chatThreadId);
    try {
      if (ctx.store.tx(() => paused(db, chat.chatThreadId)))
        return refused("CONVERSATION_PAUSED");
      const item = storeItem();
      let threadPost: "posted" | "failed" = "posted";
      try {
        const posted = await postAgentText(ctx, {
          target: { kind: "thread", chatThreadId: chat.chatThreadId },
          channelId: chat.channelId,
          projectName:
            config.projects.find((entry) => entry.projectId === projectId)
              ?.name ?? projectId,
          label: `Forge (${person.displayName}'s agent)`,
          prefix: `${person.displayName}'s agent asked ${result.owner.displayName}'s agent:`,
          text,
          fallbackName: person.displayName,
          conversation: chat,
          sessionId,
          personId: person.personId,
        });
        ctx.store.tx(() =>
          recordAgentPost(
            ctx,
            posted.ref,
            chat,
            sessionId,
            person.personId,
            posted.text,
          ),
        );
        if (chat.projectId !== undefined)
          await postLoopPause(ctx, chat, chat.projectId);
      } catch (error) {
        if (!(error instanceof ChatWriteFailure)) throw error;
        threadPost = "failed";
      }
      await deliver(item);
      return { ok: true, value: { itemId: item.id, threadPost } };
    } finally {
      release();
    }
  };
}
