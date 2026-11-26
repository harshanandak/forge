import { ChatWriteFailure } from "../contract/chat.ts";
import { record, string } from "./probe.ts";

export type TelegramFetch = (url: URL, init: RequestInit) => Promise<Response>;

export type TelegramMethod = keyof typeof decode;

export interface TelegramApi {
  request<M extends TelegramMethod>(
    method: M,
    body?: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<TelegramResult<M>>;
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

export function telegramId(value: unknown, signed = false): value is number {
  return integer(value) && (signed ? value !== 0 : value > 0);
}

function author(value: unknown) {
  const user = record(value);
  if (!telegramId(user?.id) || typeof user.is_bot !== "boolean") return;
  return {
    id: user.id,
    is_bot: user.is_bot,
    username: string(user.username),
    name: string(user.first_name) ?? "",
  };
}

function messageRef(value: unknown) {
  const message = record(value);
  const chat = record(message?.chat);
  if (!telegramId(chat?.id, true) || !telegramId(message?.message_id)) return;
  const isDirect = chat.type === "private" && chat.id > 0;
  const isGroup = ["group", "supergroup", "channel"].some(
    (type) => type === chat.type,
  );
  if (!isDirect && !(chat.id < 0 && isGroup)) return;
  return { chatId: chat.id, messageId: message.message_id, isDirect };
}

function message(value: unknown, allowInaccessible = false) {
  const ref = messageRef(value);
  const data = record(value);
  if (!ref || !data) return;
  if (!telegramId(data.date) && !(allowInaccessible && data.date === 0)) return;
  const reply = messageRef(data.reply_to_message);
  return {
    ...ref,
    sender: data.sender_chat === undefined ? author(data.from) : undefined,
    topic:
      data.is_topic_message === true && telegramId(data.message_thread_id)
        ? data.message_thread_id
        : undefined,
    replyTo: reply?.chatId === ref.chatId ? reply.messageId : undefined,
    text: string(data.text) ?? string(data.caption) ?? "",
    fileName: string(record(data.document)?.file_name),
  };
}

export type TelegramMessage = NonNullable<ReturnType<typeof message>>;

function updates(value: unknown) {
  if (!Array.isArray(value)) return;
  const parsed = [];
  for (const entry of value as unknown[]) {
    const data = record(entry);
    const id = data?.update_id;
    if (!integer(id) || id < 0 || id === Number.MAX_SAFE_INTEGER) return;
    const query = record(data?.callback_query);
    parsed.push({
      id,
      callback: {
        id: string(query?.id),
        data: string(query?.data),
        sender: author(query?.from),
        message: message(query?.message, true),
      },
      message: message(data?.message),
      edited: message(data?.edited_message),
    });
  }
  return parsed.sort((left, right) => left.id - right.id);
}

export type TelegramUpdate = NonNullable<ReturnType<typeof updates>>[number];

function webhook(value: unknown) {
  const url = record(value)?.url;
  return typeof url === "string" ? { registered: url !== "" } : undefined;
}

function botIdentity(value: unknown) {
  const user = author(value);
  return user?.is_bot ? user : undefined;
}

const decode = {
  getUpdates: updates,
  sendMessage: messageRef,
  editMessageText: messageRef,
  editMessageReplyMarkup: messageRef,
  answerCallbackQuery: (value: unknown) => (value === true ? true : undefined),
  getWebhookInfo: webhook,
  getMe: botIdentity,
};

type TelegramResult<M extends TelegramMethod> = NonNullable<
  ReturnType<(typeof decode)[M]>
>;

export class TelegramEditFailure extends ChatWriteFailure {
  readonly problem: "unchanged" | "missing";
  constructor(problem: TelegramEditFailure["problem"]) {
    super("refused");
    this.problem = problem;
  }
}

function apiFailure(
  method: TelegramMethod,
  status: number,
  value: ReturnType<typeof record>,
) {
  const code = value?.error_code;
  if (
    value?.ok !== false ||
    !integer(code) ||
    (status !== code && status !== 200)
  )
    return new ChatWriteFailure("unknown");
  if (code === 429) {
    const seconds = record(value.parameters)?.retry_after;
    if (
      integer(seconds) &&
      seconds >= 0 &&
      Number.isSafeInteger(seconds * 1_000)
    )
      return new ChatWriteFailure("refused", seconds * 1_000);
    return new ChatWriteFailure("unknown");
  }
  if (
    code === 400 &&
    (method === "editMessageText" || method === "editMessageReplyMarkup")
  ) {
    const description = string(value.description)?.toLowerCase() ?? "";
    if (description.startsWith("bad request: message is not modified"))
      return new TelegramEditFailure("unchanged");
    if (description === "bad request: message to edit not found")
      return new TelegramEditFailure("missing");
  }
  if (code === 403)
    return new ChatWriteFailure("refused", undefined, "restricted_action");
  return new ChatWriteFailure(
    code >= 400 && code < 500 && code !== 408 ? "refused" : "unknown",
  );
}

export function createTelegramApi(
  token: string,
  fetch: TelegramFetch,
): TelegramApi {
  if (!/^[A-Za-z0-9_:-]+$/.test(token)) throw new ChatWriteFailure("refused");
  return {
    async request(method, body = {}, signal?) {
      if (!Object.hasOwn(decode, method)) throw new ChatWriteFailure("refused");
      const deadline = new AbortController();
      const timer = setTimeout(
        () => deadline.abort(),
        method === "getUpdates" ? 40_000 : 10_000,
      );
      let response: Response;
      let data: ReturnType<typeof record>;
      try {
        response = await fetch(
          new URL(`https://api.telegram.org/bot${token}/${method}`),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            redirect: "error",
            signal: signal
              ? AbortSignal.any([deadline.signal, signal])
              : deadline.signal,
          },
        );
        data = record(await response.json());
      } catch {
        throw new ChatWriteFailure("unknown");
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok || data?.ok !== true)
        throw apiFailure(method, response.status, data);
      const result = decode[method](data.result);
      if (result === undefined) throw new ChatWriteFailure("unknown");
      return result as TelegramResult<typeof method>;
    },
  };
}
