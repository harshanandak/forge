import { setTimeout as delay } from "node:timers/promises";
import { ChatWriteFailure } from "../contract/chat.ts";
import type { HubLog } from "../contract/runtime.ts";
import type { TelegramApi, TelegramUpdate } from "./telegram-wire.ts";

export type TelegramSleep = (
  delayMs: number,
  signal: AbortSignal,
) => Promise<void>;

type Handle = (
  update: TelegramUpdate,
  username: string | undefined,
) => Promise<void>;

const activeBots = new Set<number>();
const maxBackoffMs = 30_000;
const sleepUntil: TelegramSleep = (ms, signal) =>
  delay(ms, undefined, { signal, ref: false });

export function createTelegramPolling(
  api: TelegramApi,
  log: HubLog,
  sleep = sleepUntil,
) {
  let running:
    | {
        controller: AbortController;
        ready: Promise<void>;
        finished: Promise<void>;
      }
    | undefined;
  let offset = 0;

  async function poll(
    signal: AbortSignal,
    handle: (update: TelegramUpdate) => Promise<void>,
  ) {
    let backoffMs = 1_000;
    while (!signal.aborted) {
      try {
        const updates = await api.request(
          "getUpdates",
          {
            offset,
            timeout: 30,
            allowed_updates: ["message", "edited_message", "callback_query"],
          },
          signal,
        );
        for (const update of updates) {
          if (signal.aborted) return;
          if (update.id < offset) continue;
          await handle(update);
          offset = update.id + 1;
        }
        if (updates.length === 0) offset = 0;
        backoffMs = 1_000;
      } catch (error) {
        if (signal.aborted) return;
        const wait =
          error instanceof ChatWriteFailure ? error.retryAfterMs : undefined;
        log.warn("telegram_poll_retry");
        await sleep(
          Math.min(maxBackoffMs, Math.max(backoffMs, wait ?? 0)),
          signal,
        );
        backoffMs = Math.min(maxBackoffMs, backoffMs * 2);
      }
    }
  }

  async function run(
    signal: AbortSignal,
    ready: ReturnType<typeof Promise.withResolvers<void>>,
    handle: Handle,
  ) {
    const webhook = await api.request("getWebhookInfo", {}, signal);
    if (webhook.registered) {
      log.warn("telegram_webhook_registered");
      throw new ChatWriteFailure("refused");
    }
    const bot = await api.request("getMe", {}, signal);
    if (signal.aborted || activeBots.has(bot.id))
      throw new ChatWriteFailure("refused");
    activeBots.add(bot.id);
    ready.resolve();
    try {
      await poll(signal, (update) => handle(update, bot.username));
    } finally {
      activeBots.delete(bot.id);
    }
  }

  return {
    start(handle: Handle) {
      if (running) return running.ready;
      const controller = new AbortController();
      const ready = Promise.withResolvers<void>();
      const finished = run(controller.signal, ready, handle)
        .catch((error: unknown) => {
          const effect =
            error instanceof ChatWriteFailure ? error.effect : "unknown";
          ready.reject(new ChatWriteFailure(effect));
        })
        .finally(() => {
          running = undefined;
        });
      running = { controller, ready: ready.promise, finished };
      return ready.promise;
    },
    async stop() {
      const current = running;
      current?.controller.abort();
      await current?.finished;
    },
  };
}
