import { inspect } from "node:util";
import { afterEach, expect } from "bun:test";
import { createTelegramChatPort } from "../../src/chat/index.ts";
import type { TelegramOptions } from "../../src/chat/telegram.ts";
import type { ChatInboundHandlers, ChatPort } from "../../src/contract/chat.ts";
import type { HubDb, HubLog, ReadSecret } from "../../src/contract/runtime.ts";
import { fakeTelegram, fixtureTelegramToken } from "../fakes/fake-telegram.ts";
import { testDb } from "./fixtures.ts";

export const telegramTimeout = 30_000;
export const idleHandlers: ChatInboundHandlers = {
  onAction: () => Promise.resolve({}),
  onMessage: () => Promise.resolve(),
  onMessageChange: () => Promise.resolve(),
};

export async function startTelegram(port: ChatPort, handlers = idleHandlers) {
  await expect(port.start(handlers)).resolves.toBeUndefined();
}

const databases = new Set<HubDb>();

afterEach(() => {
  for (const db of databases) db.close();
  databases.clear();
});

function telegramDb(): HubDb {
  const db = testDb(":memory:", true);
  databases.add(db);
  return db;
}

export function telegramFixture(
  fake = fakeTelegram(),
  options: Omit<TelegramOptions, "fetch"> = {},
  db = telegramDb(),
) {
  const logs: unknown[] = [];
  const reads: Parameters<ReadSecret>[0][] = [];
  const record: HubLog["info"] = (event, fields) =>
    logs.push({ event, fields });
  const createPort = () =>
    createTelegramChatPort(
      {
        db,
        log: { info: record, warn: record, error: record },
        secret(name) {
          reads.push(name);
          return name === "TELEGRAM_BOT_TOKEN"
            ? fixtureTelegramToken
            : undefined;
        },
      },
      { ...options, fetch: fake.fetch },
    );
  return {
    fake,
    logs,
    reads,
    createPort,
    port: createPort(),
  };
}

export function containsTelegramToken(value: unknown) {
  const output = inspect(value, { depth: null, showHidden: true });
  return output.includes(fixtureTelegramToken);
}
