import { ChatWriteFailure } from "../contract/chat.ts";
import type { HubCore, HubResult } from "../contract/core.ts";
import type { Person, Session } from "../contract/domain.ts";
import { LIMITS, type SendInput } from "../contract/mcp.ts";
import { AgentPostOutcomeError, recoverAgentPosts } from "./agent-posts.ts";
import type { CoreContext } from "./core.ts";
import { refused } from "./inbox.ts";
import { postAgentText } from "./reply.ts";
import { frontSession, insertItem } from "./routing.ts";
import {
  byConversation,
  channelBindingRefusal,
  enterThread,
  paused,
  postLoopPause,
} from "./thread.ts";

type SendTransaction = <T>(work: () => HubResult<T>) => HubResult<T>;

export function createSend(ctx: CoreContext): HubCore["send"] {
  const send = createMessageSend(ctx, "agent", ctx.store.tx);
  return (caller, input) => send(caller.person, input);
}

export function createPrivateSend(
  ctx: CoreContext,
  tx: SendTransaction,
): HubCore["cliSend"] {
  return createMessageSend(ctx, "cli", tx);
}

function createMessageSend(
  ctx: CoreContext,
  kind: "agent" | "cli",
  tx: SendTransaction,
): (person: Person, input: SendInput) => ReturnType<HubCore["send"]> {
  return async (person, input) => {
    const { config, db, people } = ctx.deps;
    const { guards, sessions } = ctx.store;
    const { projectId, toPersonId, sessionId, targetSessionId, text } = input;
    const conversationId = kind === "agent" ? input.conversationId : undefined;
    const storeItem = (owner: Person, target: Session | undefined) =>
      insertItem(ctx, {
        owner,
        sender: person,
        senderSession: { kind, sessionId },
        projectId,
        target,
        text: guards.storedText(text),
      });
    const result = tx(() => {
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
      if (kind === "cli" && own.value.projectId !== projectId)
        return refused("INPUT_INVALID", "/projectId");
      const chat =
        conversationId === undefined
          ? undefined
          : byConversation(db, conversationId);
      if (conversationId !== undefined) {
        if (!chat) return refused("CONVERSATION_UNKNOWN");
        if (chat.personId !== person.personId)
          return refused("CONVERSATION_NOT_YOURS");
        const binding = channelBindingRefusal(db, chat, projectId);
        if (binding) return binding;
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
          (target.projectId !== projectId &&
            (kind === "cli" || target.projectId !== undefined)))
      )
        return refused("SESSION_UNKNOWN");
      const recorded = kind === "cli" ? storeItem(owner, target) : undefined;
      return { ok: true, value: { owner, target, chat, recorded } } as const;
    });
    if (!result.ok) return result;
    const { owner, target, chat, recorded } = result.value;
    const commitItem = () => ctx.store.tx(() => storeItem(owner, target));
    const deliver = async (item: ReturnType<typeof storeItem>) => {
      await ctx.notify({
        person: owner,
        projectId,
        items: [item.id],
        answers: [],
        ...(item.session === undefined ? {} : { session: item.session }),
      });
    };
    if (!chat || chat.isDirect) {
      const item = recorded ?? commitItem();
      await deliver(item);
      return { ok: true, value: { itemId: item.id } };
    }
    const release = await enterThread(ctx, chat.chatThreadId);
    try {
      const blocked = ctx.store.tx(() => {
        const fresh = byConversation(db, chat.conversationId);
        if (!fresh) return refused("CONVERSATION_UNKNOWN");
        const binding = channelBindingRefusal(db, fresh, projectId);
        if (binding) return binding;
        return undefined;
      });
      if (blocked) return blocked;
      try {
        recoverAgentPosts(ctx, chat.chatThreadId);
      } catch {
        return refused("CHAT_UNAVAILABLE");
      }
      if (paused(db, chat.chatThreadId)) {
        await postLoopPause(ctx, chat);
        return refused("CONVERSATION_PAUSED");
      }
      const item = commitItem();
      let threadPost: "posted" | "failed" = "posted";
      try {
        const posted = await postAgentText(ctx, {
          target: { kind: "thread", chatThreadId: chat.chatThreadId },
          channelId: chat.channelId,
          projectName:
            config.projects.find((entry) => entry.projectId === projectId)
              ?.name ?? projectId,
          label: `Forge (${person.displayName}'s agent)`,
          prefix: `${person.displayName}'s agent asked ${owner.displayName}'s agent:`,
          text,
          fallbackName: person.displayName,
          conversation: chat,
          sessionId,
          personId: person.personId,
        });
        if (posted.projected) await postLoopPause(ctx, chat);
      } catch (error) {
        if (!(
          error instanceof ChatWriteFailure ||
          error instanceof AgentPostOutcomeError
        ))
          throw error;
        threadPost = "failed";
      }
      await deliver(item);
      return { ok: true, value: { itemId: item.id, threadPost } };
    } finally {
      release();
    }
  };
}
