import type { HubCore } from "../contract/core.ts";
import { LIMITS } from "../contract/mcp.ts";
import type { CoreContext } from "./core.ts";
import { refused } from "./inbox.ts";
import { frontSession, insertItem } from "./routing.ts";
import { byConversation, paused } from "./thread.ts";

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
      if (conversationId !== undefined) {
        const chat = byConversation(db, conversationId);
        if (!chat) return refused("CONVERSATION_UNKNOWN");
        if (chat.personId !== person.personId)
          return refused("CONVERSATION_NOT_YOURS");
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
      const item = insertItem(ctx, {
        owner,
        sender: person,
        agent: sessionId,
        projectId,
        target,
        text: guards.storedText(text),
      });
      return { ok: true, owner, item } as const;
    });
    if (!result.ok) return result;
    const { id, session } = result.item;
    await ctx.notify({
      person: result.owner,
      projectId,
      items: [id],
      answers: [],
      ...(session === undefined ? {} : { session }),
    });
    return { ok: true, value: { itemId: id } };
  };
}
