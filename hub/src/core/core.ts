import type { ChatInboundHandlers, ChatPort } from "../contract/chat.ts";
import type { HubCore } from "../contract/core.ts";
import type { CoreDeps } from "../contract/runtime.ts";
import { recoverAgentPosts, type SettledAgentPost } from "./agent-posts.ts";
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
  readonly pendingAgentPosts: Map<string, SettledAgentPost>;
  readonly threadGates: Map<string, Promise<void>>;
  readonly notify: (notice: Notice) => Promise<void>;
}
export type CreateCoreContext = typeof createCoreContext;
export type CreateCoreBase = (
  ctx: CoreContext,
  extras?: CoreExtras,
) => CoreBase;

export const createCoreContext = (deps: CoreDeps, recoverPosts = true) => {
  const store = createCoreStore(deps);
  store.syncDirectory();
  const adapter = deps.config.chat?.adapter ?? "slack";
  const chatEnabled =
    adapter === "telegram" ||
    (adapter === "slack" && deps.config.slack.mode !== "off");
  const ctx: CoreContext = {
    deps,
    store,
    chat: chatEnabled ? deps.chat : undefined,
    waiters: createWaiters(),
    threadGates: new Map(),
    pendingAgentPosts: new Map(),
    notify: (notice) =>
      notify(ctx, notice).catch(() =>
        deps.log.warn("delivery_notification_failed"),
      ),
  };
  if (recoverPosts) recoverAgentPosts(ctx);
  return ctx;
};

export const createCoreBase: CreateCoreBase = (ctx, extras) => {
  const { chat, deps, store } = ctx;
  const slackContext =
    deps.config.chat?.adapter === "telegram"
      ? { ...ctx, chat: undefined }
      : ctx;
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
          deps.config.chat?.adapter === "telegram" && event.isDirect
            ? postNotice(chat, event, text)
            : chat.postEphemeral(event, event.slackUserId, text),
        );
      } else if (slackContext.chat) {
        await route(ctx, event);
      }
    },
    onMessageChange(event) {
      if (slackContext.chat) changed(ctx, event);
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
    reply: createReply(slackContext),
    inbox: (caller, input) => delivery(ctx, caller, input),
    wait: createWait(ctx),
    send: createSend(slackContext),
  };
};
