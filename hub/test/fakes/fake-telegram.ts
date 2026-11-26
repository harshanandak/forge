import type {
  TelegramFetch,
  TelegramMethod,
} from "../../src/chat/telegram-wire.ts";

type Fields = Readonly<Record<string, unknown>>;
type Update = Fields & { readonly update_id: number };
type Call = { readonly method: string; readonly body: Fields };
type Responder = (url: URL, body: Fields) => Response | Promise<Response>;

export const fixtureTelegramToken = "synthetic-telegram-token";
export const telegramA = 101;
export const telegramB = 102;
export const telegramC = 103;
export const telegramGroup = -100200;
const bot = {
  id: 201,
  is_bot: true,
  first_name: "Forge",
  username: "ForgeBot",
};

export function telegramMessage(
  chatId: number,
  messageId: number,
  fields: Fields = {},
) {
  return {
    message_id: messageId,
    date: 1_800_000_000,
    chat: { id: chatId, type: chatId < 0 ? "supergroup" : "private" },
    from: {
      id: chatId > 0 ? chatId : telegramA,
      is_bot: false,
      first_name: "Fixture",
    },
    text: "fixture",
    ...fields,
  };
}

export function tap(
  updateId: number,
  userId: number,
  chatId: number,
  messageId: number,
  data = "fa1:0",
  callbackId = "callback-" + updateId,
) {
  return {
    update_id: updateId,
    callback_query: {
      id: callbackId,
      from: { id: userId, is_bot: false, first_name: "Fixture" },
      chat_instance: "fixture-chat",
      data,
      message: telegramMessage(chatId, messageId, { from: bot }),
    },
  };
}

export function telegramOk(result: unknown): Response {
  return Response.json({ ok: true, result });
}

export function telegramError(
  errorCode: number,
  description: string,
  parameters?: Fields,
): Response {
  return Response.json(
    { ok: false, error_code: errorCode, description, parameters },
    { status: errorCode },
  );
}

function decimalId(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^-?[0-9]+$/.test(value))
    return Number(value);
  throw new Error("Expected a Telegram decimal id");
}

export function fakeTelegram(token = fixtureTelegramToken) {
  const calls: Call[] = [];
  const stream: Update[] = [];
  const replies = new Map<TelegramMethod, Responder[]>();
  const cards = new Map<number, unknown>();
  let changed = Promise.withResolvers<void>();
  let sequence = 300;
  let activePolls = 0;
  let maxActivePolls = 0;
  let cancelledPolls = 0;
  function signalChange() {
    changed.resolve();
    changed = Promise.withResolvers<void>();
  }
  async function poll(body: Fields, signal?: AbortSignal | null) {
    if (!signal) throw new Error("A Telegram poll must be cancellable");
    activePolls++;
    maxActivePolls = Math.max(maxActivePolls, activePolls);
    const onAbort = () => signalChange();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      for (;;) {
        signal.throwIfAborted();
        const offset = body.offset === undefined ? 0 : decimalId(body.offset);
        const ready = stream.filter((update) => update.update_id >= offset);
        stream.splice(0, stream.length, ...ready);
        if (ready.length) return telegramOk(ready);
        await changed.promise;
      }
    } finally {
      activePolls--;
      if (signal.aborted) cancelledPolls++;
      signal.removeEventListener("abort", onAbort);
    }
  }
  const fetch: TelegramFetch = async (url, init) => {
    const path = new URL(url).pathname.split("/");
    if (path.length !== 3 || path[1] !== "bot" + token || !path[2])
      throw new Error("Unexpected Telegram request path");
    const method = path[2];
    const body: Fields =
      typeof init.body === "string" ? (JSON.parse(init.body) as Fields) : {};
    calls.push({ method, body });
    signalChange();
    const next = replies.get(method as TelegramMethod)?.shift();
    if (next) return next(url, body);
    switch (method) {
      case "getWebhookInfo":
        return telegramOk({
          url: "",
          has_custom_certificate: false,
          pending_update_count: 0,
        });
      case "getMe":
        return telegramOk(bot);
      case "getUpdates":
        return poll(body, init.signal);
      case "sendMessage": {
        const id = ++sequence;
        cards.set(id, body.reply_markup);
        return telegramOk(
          telegramMessage(decimalId(body.chat_id), id, {
            from: bot,
            text: body.text,
          }),
        );
      }
      case "editMessageText":
      case "editMessageReplyMarkup": {
        const id = decimalId(body.message_id);
        if (!cards.has(id))
          return telegramError(400, "Bad Request: message to edit not found");
        if (body.reply_markup !== undefined) cards.set(id, body.reply_markup);
        return telegramOk(
          telegramMessage(decimalId(body.chat_id), id, {
            from: bot,
            text: body.text ?? "fixture",
          }),
        );
      }
      case "answerCallbackQuery":
        return telegramOk(true);
      default:
        throw new Error("Unexpected Telegram API method");
    }
  };
  return {
    fetch,
    calls,
    cards,
    get maxActivePolls() {
      return maxActivePolls;
    },
    get cancelledPolls() {
      return cancelledPolls;
    },
    get activePolls() {
      return activePolls;
    },
    push(...updates: readonly Update[]) {
      stream.push(...updates);
      signalChange();
    },
    respond(method: TelegramMethod, responder: Responder) {
      const queue = replies.get(method) ?? [];
      queue.push(responder);
      replies.set(method, queue);
    },
    only(method: TelegramMethod) {
      return calls
        .filter((entry) => entry.method === method)
        .map(({ body }) => body);
    },
    async until(matched: (call: Call) => boolean) {
      for (;;) {
        const call = calls.find(matched);
        if (call) return call.body;
        await changed.promise;
      }
    },
    async handled(id: number) {
      await this.until(
        ({ method, body }) =>
          method === "getUpdates" && Number(body.offset) > id,
      );
    },
  };
}
