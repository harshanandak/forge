import type { TelegramApi } from "./telegram-wire.ts";

export type TelegramSleep = (
  delayMs: number,
  signal: AbortSignal,
) => Promise<void>;

export interface TelegramPolling {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createTelegramPolling(
  _api: TelegramApi,
  _handle: (update: unknown) => Promise<void>,
  _sleep?: TelegramSleep,
): TelegramPolling {
  const refuse = () => Promise.reject(new Error("not_built"));
  return { start: refuse, stop: refuse };
}
