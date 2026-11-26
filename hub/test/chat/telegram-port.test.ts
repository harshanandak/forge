import { expect, test } from "bun:test";
import { renderTelegramAskCard } from "../../src/chat/telegram-cards.ts";
import {
  createTelegramApi,
  type TelegramMethod,
} from "../../src/chat/telegram-wire.ts";
import {
  ChatWriteFailure,
  type ChatMessageChangeEvent,
  type ChatMessageEvent,
} from "../../src/contract/chat.ts";
import { LIMITS } from "../../src/contract/mcp.ts";
import {
  fixtureTelegramToken,
  telegramA,
  telegramError,
  telegramGroup,
  telegramMessage,
  telegramOk,
} from "../fakes/fake-telegram.ts";
import { ask, failure } from "./fixtures.ts";
import { checkChatPort } from "./port-contract.ts";
import {
  containsTelegramToken,
  idleHandlers,
  startTelegram,
  telegramFixture,
  telegramTimeout,
} from "./telegram-fixture.ts";

test(
  "T2-PORT1 Telegram follows the shared port contract and refuses unsupported operations",
  async () => {
    const { port, fake } = telegramFixture();
    expect(port.capabilities).toEqual({
      mode: "polling",
      buttons: true,
      editMessage: true,
      ephemeral: false,
      reactions: false,
      longAnswers: false,
      threads: true,
    });
    await checkChatPort(port, {
      userId: String(telegramA),
      channelId: String(telegramGroup),
      ephemeral: false,
      reactions: false,
      summaryLookup: "unknown",
    });
    expect(
      await failure(() =>
        port.createLongAnswer(String(telegramA), "Title", "Body"),
      ),
    ).toMatchObject({
      effect: "refused",
    });
    expect(fake.only("sendMessage").map(({ text }) => text)).not.toContain(
      "Private fixture",
    );
  },
  telegramTimeout,
);

test(
  "T2-CB1 the last choice has a versioned callback within the Bot API byte limit",
  () => {
    const view = {
      ...ask,
      choices: Array.from({ length: LIMITS.choicesMax }, (_, index) => ({
        id: "opaque-choice-" + index,
        label: "Option " + index,
      })),
    };
    expect(() => renderTelegramAskCard(view)).not.toThrow();
    const buttons =
      renderTelegramAskCard(view).reply_markup.inline_keyboard.flat();
    expect(buttons).toHaveLength(LIMITS.choicesMax);
    for (const [index, button] of buttons.entries()) {
      expect(button.callback_data).toBe("fa1:" + index);
      expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
    }
  },
  telegramTimeout,
);

test(
  "T2-PKG1 the dependency-free Bot API client calls the injected fetch",
  async () => {
    const { fake } = telegramFixture();
    const result = createTelegramApi(fixtureTelegramToken, fake.fetch).request(
      "getMe",
    );
    await expect(result).resolves.toMatchObject({ id: 201, is_bot: true });
    expect(fake.only("getMe")).toHaveLength(1);
  },
  telegramTimeout,
);

const wireMethods: readonly TelegramMethod[] = [
  "getUpdates",
  "sendMessage",
  "editMessageText",
  "editMessageReplyMarkup",
  "answerCallbackQuery",
  "getWebhookInfo",
  "getMe",
];

for (const method of wireMethods) {
  test(
    `T2-PKG1 ${method} refuses a malformed result from the injected transport`,
    async () => {
      const { fake } = telegramFixture();
      fake.respond(method, () => telegramOk({ unexpected: true }));
      const request = createTelegramApi(
        fixtureTelegramToken,
        fake.fetch,
      ).request(method, {
        chat_id: telegramA,
        message_id: 300,
        text: "Fixture",
        reply_markup: { inline_keyboard: [] },
        callback_query_id: "fixture-callback",
      });
      await expect(request).rejects.toBeInstanceOf(ChatWriteFailure);
      expect(fake.only(method)).toHaveLength(1);
    },
    telegramTimeout,
  );
}

test(
  "T2-SEC2 the token and failed request URL stay out of public errors and logs",
  async () => {
    const { fake, port, logs, reads } = telegramFixture();
    let failedUrl = "";
    fake.respond("sendMessage", (url) => {
      failedUrl = url.href;
      throw new Error("transport failed", { cause: new Error(failedUrl) });
    });
    fake.respond("sendMessage", (url) =>
      telegramError(403, "Forbidden " + url.href),
    );
    fake.respond("sendMessage", (url) =>
      Object.defineProperty(
        new Response(fixtureTelegramToken, { status: 502 }),
        "url",
        {
          value: url.href,
        },
      ),
    );
    for (let attempt = 0; attempt < 3; attempt++) {
      const pending = port.postAskDm(String(telegramA), ask);
      await expect(pending).rejects.toBeInstanceOf(ChatWriteFailure);
      const error = await failure(() => pending);
      expect(containsTelegramToken(error)).toBe(false);
    }
    expect(failedUrl.includes(fixtureTelegramToken)).toBe(true);
    expect(containsTelegramToken(logs)).toBe(false);
    expect(new Set(reads)).toEqual(new Set(["TELEGRAM_BOT_TOKEN"]));
    expect(fake.only("sendMessage")).toHaveLength(3);
  },
  telegramTimeout,
);

test(
  "T2-DM1 a blocked DM returns a typed refusal with one send attempt",
  async () => {
    const { fake, port } = telegramFixture();
    fake.respond("sendMessage", () =>
      telegramError(
        403,
        "Forbidden: bot can't initiate conversation with a user",
      ),
    );
    const pending = port.postAskDm(String(telegramA), ask);
    await expect(pending).rejects.toMatchObject({ effect: "refused" });
    expect(await failure(() => pending)).toBeInstanceOf(ChatWriteFailure);
    expect(fake.only("sendMessage")).toHaveLength(1);
  },
  telegramTimeout,
);

test(
  "T2-GRP1 replies share a root, forum topics stay apart and edited updates are changes",
  async () => {
    const { fake, port } = telegramFixture();
    const messages: ChatMessageEvent[] = [];
    const changes: ChatMessageChangeEvent[] = [];
    const root = telegramMessage(telegramGroup, 100);
    const reply = telegramMessage(telegramGroup, 101, {
      reply_to_message: root,
    });
    const nested = telegramMessage(telegramGroup, 102, {
      reply_to_message: { ...reply, reply_to_message: undefined },
    });
    const topic = (messageId: number, topicId: number) =>
      telegramMessage(telegramGroup, messageId, {
        message_thread_id: topicId,
        is_topic_message: true,
      });
    await startTelegram(port, {
      ...idleHandlers,
      onMessage(event) {
        messages.push(event);
        return Promise.resolve();
      },
      onMessageChange(event) {
        changes.push(event);
        return Promise.resolve();
      },
    });
    try {
      fake.push(
        { update_id: 10, message: root },
        { update_id: 11, message: reply },
        { update_id: 12, message: nested },
        { update_id: 13, message: topic(105, 80) },
        { update_id: 14, message: topic(106, 81) },
        { update_id: 15, message: topic(107, 80) },
        {
          update_id: 16,
          edited_message: {
            ...reply,
            text: "edited content",
            edit_date: 1_800_000_001,
          },
        },
      );
      await fake.handled(16);
      expect(messages.map(({ chatMessageId }) => chatMessageId)).toEqual([
        "100",
        "101",
        "102",
        "105",
        "106",
        "107",
      ]);
      const [first, second, third, topicA, topicB, topicAAgain] = messages;
      if (!(first && second && third && topicA && topicB && topicAAgain))
        throw new Error("Expected all fixture messages");
      expect(first.channelId).toBe(String(telegramGroup));
      expect(second.chatThreadId).toBe(first.chatThreadId);
      expect(third.chatThreadId).toBe(first.chatThreadId);
      expect(topicA.chatThreadId).toBe(topicAAgain.chatThreadId);
      expect(topicA.chatThreadId).not.toBe(topicB.chatThreadId);
      expect(topicA.chatThreadId).not.toBe(first.chatThreadId);
      expect(changes).toMatchObject([
        {
          kind: "edited",
          text: "edited content",
          chatMessageId: "101",
          chatThreadId: first.chatThreadId,
        },
      ]);
      await port.postText(
        { kind: "thread", chatThreadId: third.chatThreadId },
        "Group reply",
      );
      await port.postText(
        { kind: "thread", chatThreadId: topicA.chatThreadId },
        "Topic reply",
      );
      const [groupSend, topicSend] = fake.only("sendMessage");
      expect(
        Number(
          (groupSend?.reply_parameters as { message_id?: unknown } | undefined)
            ?.message_id,
        ),
      ).toBe(100);
      expect(Number(topicSend?.message_thread_id)).toBe(80);
    } finally {
      await port.stop();
    }
  },
  telegramTimeout,
);
