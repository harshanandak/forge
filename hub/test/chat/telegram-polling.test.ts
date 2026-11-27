import { expect, test } from "bun:test";
import type { TelegramSleep } from "../../src/chat/telegram-polling.ts";
import {
  ChatWriteFailure,
  type ChatActionEvent,
} from "../../src/contract/chat.ts";
import {
  tap,
  telegramA,
  telegramError,
  telegramOk,
} from "../fakes/fake-telegram.ts";
import {
  idleHandlers,
  startTelegram,
  telegramFixture,
  telegramTimeout,
} from "./telegram-fixture.ts";

test(
  "T2-POLL1 repeated starts use one poller and repeated stops cancel the long poll",
  async () => {
    const { fake, port } = telegramFixture();
    await expect(
      Promise.all([port.start(idleHandlers), port.start(idleHandlers)]),
    ).resolves.toEqual([undefined, undefined]);
    try {
      await fake.until(({ method }) => method === "getUpdates");
      expect(fake.only("getUpdates")).toHaveLength(1);
      expect(fake.activePolls).toBe(1);
      expect(fake.maxActivePolls).toBe(1);
    } finally {
      await Promise.all([port.stop(), port.stop()]);
    }
    expect(fake.activePolls).toBe(0);
    expect(fake.cancelledPolls).toBe(1);
  },
  telegramTimeout,
);

test(
  "T2-POLL1 a bot token cannot start a second concurrent poller",
  async () => {
    const { fake, port, createPort } = telegramFixture();
    const other = createPort();
    await startTelegram(port);
    try {
      await fake.until(({ method }) => method === "getUpdates");
      const result: unknown = await other
        .start(idleHandlers)
        .catch((error: unknown) => error);
      if (result !== undefined)
        expect(result).toMatchObject({ effect: "refused" });
      expect(fake.activePolls).toBe(1);
      expect(fake.maxActivePolls).toBe(1);
    } finally {
      await other.stop();
      await port.stop();
    }
  },
  telegramTimeout,
);

test(
  "T2-POLL1 rate limiting waits for retry_after and caps excessive delays",
  async () => {
    const delays: number[] = [];
    const { fake, port } = telegramFixture(undefined, {
      sleep(delay) {
        delays.push(delay);
        return Promise.resolve();
      },
    });
    const excessiveSeconds = 1_000_000;
    for (const seconds of [2, excessiveSeconds])
      fake.respond("getUpdates", () =>
        telegramError(429, "Too Many Requests", { retry_after: seconds }),
      );
    await startTelegram(port);
    try {
      await fake.until(
        ({ method }) =>
          method === "getUpdates" && fake.only("getUpdates").length === 3,
      );
      expect(delays).toHaveLength(2);
      expect(delays[0]).toBe(2_000);
      expect(delays[1]).toBeGreaterThanOrEqual(2_000);
      expect(delays[1]).toBeLessThan(excessiveSeconds * 1_000);
      expect(fake.activePolls).toBe(1);
    } finally {
      await port.stop();
    }
    expect(fake.activePolls).toBe(0);
  },
  telegramTimeout,
);

test(
  "T2-POLL1 an existing webhook is reported and never removed",
  async () => {
    const { fake, port } = telegramFixture();
    fake.respond("getWebhookInfo", () =>
      telegramOk({
        url: "https://example.test/existing-webhook",
        has_custom_certificate: false,
        pending_update_count: 0,
      }),
    );
    const started = port.start(idleHandlers);
    await expect(started).rejects.toBeInstanceOf(ChatWriteFailure);
    await expect(started).rejects.toMatchObject({ effect: "refused" });
    expect(fake.only("getWebhookInfo")).toHaveLength(1);
    expect(fake.calls.map(({ method }) => method)).not.toContain(
      "deleteWebhook",
    );
    expect(fake.only("getUpdates")).toHaveLength(0);
  },
  telegramTimeout,
);

test(
  "T2-POLL2 a handler failure leaves the update available to the restarted poller",
  async () => {
    const retry = Promise.withResolvers<AbortSignal>();
    const sleep: TelegramSleep = (_delay, signal) => {
      retry.resolve(signal);
      return new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    };
    const { fake, port, createPort } = telegramFixture(undefined, { sleep });
    const id = 80;
    const failed: ChatActionEvent[] = [];
    await startTelegram(port, {
      ...idleHandlers,
      onAction(event) {
        failed.push(event);
        return Promise.reject(new Error("Interrupted in the handler"));
      },
    });
    const update = tap(id, telegramA, telegramA, 300);
    try {
      fake.push(update);
      const signal = await retry.promise;
      expect(signal.aborted).toBe(false);
      expect(failed).toHaveLength(1);
      expect(
        fake.only("getUpdates").some(({ offset }) => Number(offset) > id),
      ).toBe(false);
    } finally {
      await port.stop();
    }
    expect((await retry.promise).aborted).toBe(true);

    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const handled: ChatActionEvent[] = [];
    const restarted = createPort();
    await startTelegram(restarted, {
      ...idleHandlers,
      async onAction(event) {
        handled.push(event);
        entered.resolve();
        await release.promise;
        return {};
      },
    });
    try {
      await entered.promise;
      expect(
        fake.only("getUpdates").some(({ offset }) => Number(offset) > id),
      ).toBe(false);
      release.resolve();
      await fake.handled(id);
      expect(handled).toEqual(failed);
      expect(fake.only("answerCallbackQuery")).toHaveLength(1);
    } finally {
      release.resolve();
      await restarted.stop();
    }
  },
  telegramTimeout,
);
