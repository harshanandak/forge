export type TelegramFetch = (url: URL, init: RequestInit) => Promise<Response>;

export type TelegramMethod =
  | "getUpdates"
  | "sendMessage"
  | "editMessageText"
  | "editMessageReplyMarkup"
  | "answerCallbackQuery"
  | "getWebhookInfo"
  | "getMe";

export interface TelegramApi {
  request(
    method: TelegramMethod,
    body?: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

export function createTelegramApi(
  _token: string,
  _fetch: TelegramFetch,
): TelegramApi {
  return {
    request: () => Promise.reject(new Error("not_built")),
  };
}
