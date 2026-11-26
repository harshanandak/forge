import type { ChatInboundHandlers, ChatPort } from "../contract/chat.ts";
import type { HubCore } from "../contract/core.ts";
import type { CoreDeps } from "../contract/runtime.ts";
import { bestEffort, type Notice, notify, postNotice } from "./doorbell.ts";
import { delivery, refused } from "./inbox.ts";
import { createReply } from "./reply.ts";
import { route } from "./routing.ts";
import { createSend } from "./send.ts";
import { createCoreStore } from "./store-impl.ts";
import type { AnswerAfter, CoreStore } from "./store.ts";
import { changed } from "./thread.ts";
import { createWait, createWaiters } from "./waiters.ts";

export interface CoreExtras {
  readonly kickEffects?: () => void;
}

export type CoreBase = Omit<
  HubCore,
  "report" | "hookStop" | "cliInbox" | "cliSend" | "start" | "close"
>;
export interface CoreContext {
  readonly deps: CoreDeps;
  readonly store: CoreStore;
  readonly chat: ChatPort | undefined;
  readonly waiters: ReturnType<typeof createWaiters>;
  readonly threadGates: Map<string, Promise<void>>;
  readonly notify: (notice: Notice) => Promise<void>;
}
export type CreateCoreContext = (deps: CoreDeps) => CoreContext;
export type CreateCoreBase = (
  ctx: CoreContext,
  extras?: CoreExtras,
) => CoreBase;

export const createCoreContext: CreateCoreContext = (deps) => {
  const store = createCoreStore(deps);
  store.syncDirectory();
  const ctx: CoreContext = {
    deps,
    store,
    chat: deps.config.slack.mode === "off" ? undefined : deps.chat,
    waiters: createWaiters(),
    threadGates: new Map(),
    notify: (notice) =>
      notify(ctx, notice).catch(() =>
        deps.log.warn("delivery_notification_failed"),
      ),
  };
  return ctx;
};

export const createCoreBase: CreateCoreBase = (ctx, extras) => {
  const { chat, deps, store } = ctx;
  const { sessions, credentials, asks } = store;
  function afterCommit(after: AnswerAfter | undefined) {
    if (!after) return;
    setImmediate(() => {
      if (after.queuedEdits) {
        try {
          extras?.kickEffects?.();
        } catch {
          deps.log.warn("effect_kick_failed");
        }
      }
      const person = deps.people.byPersonId(after.fromPersonId);
      if (person)
        void ctx.notify({
          person,
          projectId: after.projectId,
          session: after.fromSessionId,
          items: [],
          answers: [after.askId],
        });
    });
  }

  const chatHandlers: ChatInboundHandlers = {
    onAction(event) {
      const result = chat && asks?.answerAction(event);
      if (result) afterCommit(result.after);
      return Promise.resolve(result ? result.reply : {});
    },
    async onMessage(event) {
      if (!chat || !asks) return;
      if (event.isBot) {
        deps.log.info("bot_messages_dropped", { count: 1 });
        return;
      }
      const digit = asks.answerDigit(event);
      if (digit.kind === "instruction") {
        await bestEffort(ctx, () => postNotice(chat, event, digit.text));
      } else if (digit.kind === "answered") {
        afterCommit(digit.after);
        const text = digit.ephemeralText ?? "Answer recorded.";
        await bestEffort(ctx, () =>
          chat.postEphemeral(event, event.slackUserId, text),
        );
      } else {
        await route(ctx, event);
      }
    },
    onMessageChange(event) {
      if (chat) changed(ctx, event);
      return Promise.resolve();
    },
  };
  return {
    ...credentials,
    chatHandlers,
    person: (id) => deps.people.byPersonId(id),
    hello: (caller, input) => sessions.hello(caller, input),
    hookMode: (caller, input) => sessions.hookMode(caller, input),
    hookSession: (caller, input) => sessions.hookSession(caller, input),
    ask: (caller, input) =>
      chat && asks
        ? asks.ask(caller, input)
        : Promise.resolve(refused("BLOCK_DISABLED")),
    reply: createReply(ctx),
    inbox: (caller, input) => delivery(ctx, caller, input),
    wait: createWait(ctx),
    send: createSend(ctx),
  };
};
