import type { HubCore, HubResult } from "../contract/core.ts";
import type { HubError } from "../contract/errors.ts";
import { LIMITS } from "../contract/mcp.ts";
import type { CoreContext } from "./core.ts";
import { delivery, refused } from "./inbox.ts";
import { frontSession } from "./routing.ts";

class CliRefusal extends Error {
  readonly error: HubError;

  constructor(error: HubError) {
    super(error.message);
    this.error = error;
  }
}

export function createCli(
  ctx: CoreContext,
): Pick<HubCore, "cliInbox" | "cliSend"> {
  const { config, db, now, people } = ctx.deps;
  const { store } = ctx;
  const { sessions, guards, tx } = store;
  const { asks: _asks, ...itemStore } = store;
  const itemDelivery: CoreContext = {
    ...ctx,
    store: { ...itemStore, tx: (work) => work() },
  };

  const putMessage = db.prepare(`
    INSERT INTO inbox_items (item_id, dedupe_key, owner_person_id, target_session_id,
      project_id, kind, sender_kind, sender_person_id, sender_session_id,
      sender_name, not_your_owner, text, received_at)
    VALUES (?, ?, ?, ?, ?, 'cli_message', 'cli', ?, ?, ?, 1, ?, ?)
  `);

  function atomic<T>(work: () => HubResult<T>): HubResult<T> {
    try {
      return tx(() => {
        const result = work();
        if (!result.ok) throw new CliRefusal(result.error);
        return result;
      });
    } catch (error) {
      if (error instanceof CliRefusal) return { ok: false, error: error.error };
      throw error;
    }
  }

  function projectRefusal(projectId: string, personId: string) {
    if (!config.projects.some((project) => project.projectId === projectId))
      return refused("PROJECT_UNKNOWN");
    if (!sessions.isMember(projectId, personId))
      return refused("NOT_PROJECT_MEMBER");
  }

  return {
    cliInbox(person, input) {
      if (!config.cli.enabled) return refused("BLOCK_DISABLED");
      const { projectId, sessionId, ...options } = input;
      return atomic(() => {
        const existing =
          sessionId === undefined
            ? undefined
            : sessions.requireOwnSession(person, sessionId);
        if (existing?.ok === false) return existing;
        const blocked = projectRefusal(projectId, person.personId);
        if (blocked) return blocked;
        if (existing && existing.value.projectId !== projectId)
          return refused("INPUT_INVALID", "/projectId");

        const session =
          existing?.value ??
          sessions.createUnboundSession(person, projectId, "other");
        const inbox = delivery(
          itemDelivery,
          { person, tokenId: "" },
          { ...options, sessionId: session.sessionId },
        );
        if (!inbox.ok) return inbox;
        const { items, more } = inbox.value;
        return {
          ok: true,
          value: {
            sessionId: session.sessionId,
            created: existing === undefined,
            items,
            more,
          },
        };
      });
    },
    cliSend(person, input) {
      if (!config.cli.enabled) return refused("BLOCK_DISABLED");
      const { projectId, sessionId, toPersonId, targetSessionId, text } = input;
      const result = atomic(() => {
        const own = sessions.requireOwnSession(person, sessionId);
        if (!own.ok) return own;
        const blocked = projectRefusal(projectId, person.personId);
        if (blocked) return blocked;
        if (own.value.projectId !== projectId)
          return refused("INPUT_INVALID", "/projectId");
        const recipient = people.byPersonId(toPersonId);
        if (!recipient) return refused("PERSON_UNKNOWN");
        if (!sessions.isMember(projectId, toPersonId))
          return refused("NOT_PROJECT_MEMBER");
        if (!text.length || text.length > LIMITS.sendText)
          return refused("INPUT_INVALID", "/text");
        const error = guards.outboundText(text, "/text");
        if (error) return { ok: false, error } as const;

        const target =
          targetSessionId === undefined
            ? frontSession(ctx, toPersonId, projectId)
            : sessions.session(targetSessionId);
        if (
          targetSessionId !== undefined &&
          (!target ||
            target.personId !== toPersonId ||
            (target.projectId !== undefined && target.projectId !== projectId))
        )
          return refused("SESSION_UNKNOWN");

        const itemId = store.newId("item");
        const targetId = target?.sessionId;
        putMessage.run(
          itemId,
          itemId,
          toPersonId,
          targetId ?? null,
          projectId,
          person.personId,
          sessionId,
          person.displayName,
          guards.storedText(text),
          now(),
        );
        return { ok: true, value: { itemId, recipient, targetId } };
      });
      if (!result.ok) return result;
      const { itemId, recipient, targetId } = result.value;
      void ctx.notify({
        person: recipient,
        projectId,
        items: [itemId],
        answers: [],
        ...(targetId === undefined ? {} : { session: targetId }),
      });
      return { ok: true, value: { itemId } };
    },
  };
}
