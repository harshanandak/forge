import type { ChatPort } from "../contract/chat.ts";
import type { ChatDeps } from "../contract/runtime.ts";
import type { TelegramSleep } from "./telegram-polling.ts";
import type { TelegramFetch } from "./telegram-wire.ts";

export interface TelegramOptions {
  readonly fetch?: TelegramFetch;
  readonly sleep?: TelegramSleep;
}

export function createTelegramChatPort(
  _deps: Pick<ChatDeps, "secret" | "log">,
  _options?: TelegramOptions,
): ChatPort {
  const refuse = () => Promise.reject(new Error("not_built"));
  return {
    capabilities: {
      mode: "polling",
      buttons: true,
      editMessage: true,
      ephemeral: false,
      reactions: false,
      longAnswers: false,
      threads: true,
    },
    start: refuse,
    stop: refuse,
    handleWebhook: refuse,
    postAskDm: refuse,
    editAskDm: refuse,
    postText: refuse,
    postEphemeral: refuse,
    postSummary: refuse,
    findSummary: refuse,
    editSummary: refuse,
    react: refuse,
    createLongAnswer: refuse,
    probe: refuse,
  };
}
