import {
  ASK_ACTION_PREFIX,
  ChatWriteFailure,
  type ChatInboundHandlers,
  type ChatMessageRef,
  type ChatPort,
} from "../contract/chat.ts";
import { LIMITS } from "../contract/mcp.ts";
import type { ChatDeps } from "../contract/runtime.ts";
import {
  askCallbackPrefix,
  renderTelegramAskCard,
  renderTelegramSummary,
  telegramText,
} from "./telegram-cards.ts";
import {
  createTelegramPolling,
  type TelegramSleep,
} from "./telegram-polling.ts";
import {
  createTelegramApi,
  TelegramEditFailure,
  telegramId,
  type TelegramFetch,
  type TelegramMessage,
  type TelegramUpdate,
} from "./telegram-wire.ts";

export interface TelegramOptions {
  readonly fetch?: TelegramFetch;
  readonly sleep?: TelegramSleep;
}

const unsupported = () =>
  Promise.reject(
    new ChatWriteFailure("refused", undefined, "restricted_action"),
  );
const threadLimit = 4_096;

function decimal(value: string, signed = false): number {
  const id = Number(value);
  if (!telegramId(id, signed) || String(id) !== value)
    throw new ChatWriteFailure("refused");
  return id;
}

function threadKey(chatId: number, kind: "root" | "topic", id: number): string {
  return `telegram:${chatId}:${kind}:${id}`;
}

function target(thread: string) {
  const [, chat, kind, id] =
    /^telegram:([^:]+):(root|topic):([^:]+)$/.exec(thread) ?? [];
  if (!chat || !id) throw new ChatWriteFailure("refused");
  const messageId = decimal(id);
  const placement =
    kind === "topic"
      ? { message_thread_id: messageId }
      : { reply_parameters: { message_id: messageId } };
  return { chatId: decimal(chat, true), thread, placement };
}

export function createTelegramChatPort(
  { secret, log }: Pick<ChatDeps, "secret" | "log">,
  options: TelegramOptions = {},
): ChatPort {
  let token: string | undefined;
  try {
    token = secret("TELEGRAM_BOT_TOKEN");
  } catch {
    throw new ChatWriteFailure("refused");
  }
  if (!token) throw new ChatWriteFailure("refused");
  const api = createTelegramApi(token, options.fetch ?? fetch);
  const threads = new Map<string, string>();

  function makeRef(
    chatId: number,
    messageId: number,
    threadId: string,
  ): ChatMessageRef {
    const key = `${chatId}:${messageId}`;
    threads.delete(key);
    threads.set(key, threadId);
    const oldest = threads.keys().next().value;
    if (threads.size > threadLimit && oldest !== undefined)
      threads.delete(oldest);
    return {
      channelId: String(chatId),
      chatMessageId: String(messageId),
      chatThreadId: threadId,
    };
  }

  function inboundRef({ chatId, messageId, replyTo, topic }: TelegramMessage) {
    const root = replyTo ?? messageId;
    const thread = topic
      ? threadKey(chatId, "topic", topic)
      : (threads.get(`${chatId}:${root}`) ?? threadKey(chatId, "root", root));
    return makeRef(chatId, messageId, thread);
  }

  async function dispatch(
    handlers: ChatInboundHandlers,
    update: TelegramUpdate,
    username: string | undefined,
  ) {
    const { callback, message, edited } = update;
    if (callback.id) {
      const { sender, data, message: tapped } = callback;
      const value = data?.startsWith(askCallbackPrefix)
        ? data.slice(askCallbackPrefix.length)
        : "";
      let text = "This button is unavailable.";
      const validChoice =
        /^[0-9]$/.test(value) && Number(value) < LIMITS.choicesMax;
      if (sender && !sender.is_bot && tapped && validChoice) {
        const reply = await handlers.onAction({
          eventKey: "telegram:callback:" + callback.id,
          slackUserId: "",
          chatIdentity: { adapter: "telegram", userId: String(sender.id) },
          actionId: ASK_ACTION_PREFIX,
          value,
          message: inboundRef(tapped),
        });
        text = reply.ephemeralText ?? "";
      }
      try {
        await api.request("answerCallbackQuery", {
          callback_query_id: callback.id,
          ...(text ? { text: telegramText(text, 200) } : {}),
        });
      } catch (error) {
        if (
          !(error instanceof ChatWriteFailure) ||
          error.effect !== "refused" ||
          error.retryAfterMs !== undefined
        )
          throw error;
      }
      return;
    }
    if (edited) {
      await handlers.onMessageChange({
        ...inboundRef(edited),
        kind: "edited",
        text: edited.text,
        fileNames: edited.fileName ? [edited.fileName] : [],
      });
      return;
    }
    const sender = message?.sender;
    if (!message || !sender) return;
    const mentions = message.text.toLowerCase().match(/(?<!\w)@[a-z0-9_]+/g);
    await handlers.onMessage({
      ...inboundRef(message),
      eventKey: "telegram:update:" + update.id,
      chatIdentity: { adapter: "telegram", userId: String(sender.id) },
      slackUserId: "",
      userName: sender.name,
      isBot: sender.is_bot,
      text: message.text,
      isDirect: message.isDirect,
      ...(message.replyTo
        ? { threadRootMessageId: String(message.replyTo) }
        : {}),
      mentionsBot:
        !!username &&
        (mentions?.includes("@" + username.toLowerCase()) ?? false),
      mentionedSlackUserIds: [],
      fileNames: message.fileName ? [message.fileName] : [],
    });
  }

  const polling = createTelegramPolling(api, log, options.sleep);

  async function post(
    chatId: number,
    content: { readonly text: string },
    route?: ReturnType<typeof target>,
  ) {
    const posted = await api.request("sendMessage", {
      ...content,
      ...route?.placement,
      chat_id: chatId,
      link_preview_options: { is_disabled: true },
    });
    if (posted.chatId !== chatId) throw new ChatWriteFailure("unknown");
    return makeRef(
      chatId,
      posted.messageId,
      route?.thread ?? threadKey(chatId, "root", posted.messageId),
    );
  }

  async function edit(ref: ChatMessageRef, content: { readonly text: string }) {
    const chatId = decimal(ref.channelId, true);
    const messageId = decimal(ref.chatMessageId);
    if (target(ref.chatThreadId).chatId !== chatId)
      throw new ChatWriteFailure("refused");
    try {
      const edited = await api.request("editMessageText", {
        ...content,
        chat_id: chatId,
        message_id: messageId,
        link_preview_options: { is_disabled: true },
      });
      if (edited.chatId !== chatId || edited.messageId !== messageId)
        throw new ChatWriteFailure("unknown");
    } catch (error) {
      if (
        !(error instanceof TelegramEditFailure) ||
        error.problem !== "unchanged"
      )
        throw error;
    }
  }

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
    start(next) {
      return polling.start((update, username) =>
        dispatch(next, update, username),
      );
    },
    stop: () => polling.stop(),
    handleWebhook: () => Promise.resolve(new Response(null, { status: 404 })),
    postAskDm: async (userId, view) =>
      post(decimal(userId), renderTelegramAskCard(view)),
    editAskDm: (ref, view) => edit(ref, renderTelegramAskCard(view)),
    async postText(destination, text, postOptions) {
      const content = {
        text: telegramText(
          postOptions?.agentLabel ? postOptions.agentLabel + "\n" + text : text,
        ),
      };
      if (destination.kind === "channel")
        return post(decimal(destination.channelId, true), content);
      const route = target(destination.chatThreadId);
      return post(route.chatId, content, route);
    },
    postEphemeral: unsupported,
    postSummary: async (channelId, summary) =>
      post(decimal(channelId, true), { text: renderTelegramSummary(summary) }),
    findSummary: () => Promise.resolve({ kind: "unknown" }),
    async editSummary(ref, summary) {
      try {
        await edit(ref, { text: renderTelegramSummary(summary) });
        return "edited";
      } catch (error) {
        if (error instanceof TelegramEditFailure && error.problem === "missing")
          return "missing";
        throw error;
      }
    },
    react: unsupported,
    createLongAnswer: unsupported,
    async probe(channelIds) {
      if (channelIds.length) return unsupported();
      return { teamId: String((await api.request("getMe")).id), channels: [] };
    },
  };
}
