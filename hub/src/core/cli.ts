import type { HubCore, HubResult } from "../contract/core.ts";
import type { HubError } from "../contract/errors.ts";
import type { CoreContext } from "./core.ts";
import { delivery, refused } from "./inbox.ts";
import { createPrivateSend } from "./send.ts";

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
  const { config } = ctx.deps;
  const { store } = ctx;
  const { sessions, tx } = store;
  const { asks: _asks, ...itemStore } = store;
  const itemDelivery: CoreContext = {
    ...ctx,
    store: { ...itemStore, tx: (work) => work() },
  };

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

  const send = createPrivateSend(ctx, atomic);
  return {
    cliInbox(person, input) {
      if (!config.cli.enabled) return refused("BLOCK_DISABLED");
      if (input.ackItemIds !== undefined && !Array.isArray(input.ackItemIds))
        return refused("INPUT_INVALID", "/ackItemIds");
      const { projectId, sessionId, ...options } = input;
      return atomic(() => {
        const existing =
          sessionId === undefined
            ? undefined
            : sessions.requireOwnSession(person, sessionId);
        if (existing?.ok === false) return existing;
        if (!config.projects.some((project) => project.projectId === projectId))
          return refused("PROJECT_UNKNOWN");
        if (!sessions.isMember(projectId, person.personId))
          return refused("NOT_PROJECT_MEMBER");
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
    async cliSend(person, input) {
      if (!config.cli.enabled) return refused("BLOCK_DISABLED");
      if (typeof input.text !== "string")
        return refused("INPUT_INVALID", "/text");
      return send(person, input);
    },
  };
}
