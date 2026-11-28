import { expect, mock, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createTelegramChatPort } from "../../src/chat/index.ts";
import type { TelegramFetch } from "../../src/chat/telegram-wire.ts";
import type { HubCore } from "../../src/contract/core.ts";
import type { HubConfig } from "../../src/contract/runtime.ts";
import {
  createHubCore,
  loadConfig,
  nullTracker,
} from "../../src/core/index.ts";
import { main, runService } from "../../src/main.ts";
import { host, question, rows } from "../core/fakes.ts";
import {
  a,
  caller,
  closeDb,
  fixture,
  p1,
  seedDirectory,
  seedHost,
  value,
} from "../core/fixture.ts";
import {
  fakeTelegram,
  fixtureTelegramToken,
  tap,
  telegramA,
  telegramGroup,
  telegramMessage,
  telegramOk,
} from "../fakes/fake-telegram.ts";
import { mainFixture } from "./main-fixture.ts";

const timeout = 30_000;
const tokenEnv = { TELEGRAM_BOT_TOKEN: fixtureTelegramToken };
const channelId = String(telegramGroup);
const summaryMessage = {
  channelId,
  chatMessageId: "500",
  chatThreadId: `telegram:${channelId}:root:500`,
};
const telegram = {
  chat: { adapter: "telegram" },
  slack: { mode: "off", buttons: false },
  doorbells: [],
  mcp: { enabled: false },
} satisfies Partial<HubConfig>;

async function telegramHub() {
  const f = await fixture(telegram);
  const config: HubConfig = {
    ...f.config,
    projects: [
      {
        projectId: p1,
        name: "Project one",
        frontPersonId: a.personId,
        memberIds: [a.personId],
        telegramChatId: channelId,
        summaryMessage,
      },
    ],
    people: [{ ...a, telegramUserId: String(telegramA) }],
  };
  const path = join(f.root, "hub.json");
  const save = (fields: Readonly<Record<string, unknown>> = {}) =>
    writeFileSync(path, JSON.stringify({ ...config, ...fields }));
  save();
  return { ...f, config, path, save };
}

function telegramEntry(
  f: Awaited<ReturnType<typeof telegramHub>>,
  fetch: TelegramFetch,
  create = createHubCore,
) {
  return mainFixture({
    loadConfig: () => ({
      ...f.config,
      listen: { host: "127.0.0.1", port: 0 },
    }),
    loadCore: () =>
      Promise.resolve({
        nullTracker,
        openHubDb: () => ({ ...f.db, close: () => closeDb(f.db) }),
        createHubCore: create,
      }),
    createChatPort: (deps) =>
      Promise.resolve(createTelegramChatPort(deps, { fetch })),
  });
}

test(
  "W1 W4 W8 serve runs one Telegram poller, answers an ask, recovers and edits its summary, and stops on signals",
  async () => {
    const f = await telegramHub();
    seedDirectory(f.db);
    seedHost(f.db);
    f.db
      .prepare(
        `INSERT INTO summaries (project_id, publication_key, post_state, channel_id,
          chat_thread_id, chat_message_id, revision, updated_at)
        VALUES (?, 'fixture-summary', 'posted', ?, ?, '499', 1, 0)`,
      )
      .run(p1, channelId, `telegram:${channelId}:root:499`);
    const fake = fakeTelegram();
    fake.cards.set(500, undefined);
    const started = Promise.withResolvers<HubCore>();
    const entry = telegramEntry(f, fake.fetch, (deps) => {
      const core = createHubCore(deps);
      return {
        ...core,
        async start() {
          await core.start();
          started.resolve(core);
        },
        close() {
          const closing = core.close();
          expect(core.close()).toBe(closing);
          return closing;
        },
      };
    });
    const listeners = process.listenerCount("SIGTERM");
    const timers = spyOn(globalThis, "setTimeout");
    const cleared = spyOn(globalThis, "clearTimeout");
    let pollTimer: unknown;
    const run = entry.run(["serve"], tokenEnv);
    try {
      const result = await Promise.race([run, started.promise]);
      expect(typeof result).toBe("object");
      if (typeof result === "number") throw new Error(entry.stderr.join(""));
      const core = result;
      await fake.until(
        ({ method, body }) =>
          method === "editMessageText" && body.message_id === 500,
      );
      const { sessionId } = value(
        core.hookSession(host, {
          host: "claude",
          hostSessionId: "telegram-fixture",
          source: "startup",
        }),
      );
      const { askId } = value(
        await core.ask(caller, {
          sessionId,
          projectId: p1,
          kind: "work_request",
          requestedAction: "work",
          issueId: "demo-12",
          question,
        }),
      );
      expect(fake.only("sendMessage")).toMatchObject([{ chat_id: telegramA }]);
      const cardId = Number(rows(f.db, "ask_deliveries")[0]?.chat_message_id);
      fake.push(tap(1, telegramA, telegramA, cardId));
      await fake.handled(1);
      expect(rows(f.db, "ask_answers")).toMatchObject([
        { ask_id: askId, choice_id: "approve" },
      ]);
      expect(
        await core.report(caller, {
          sessionId,
          projectId: p1,
          requestAskId: askId,
          issueId: "demo-12",
          state: "working",
          text: "Working on the approved issue.",
        }),
      ).toMatchObject({
        ok: true,
        value: { summaryRevision: 2, summary: "edited" },
      });
      const edits = fake
        .only("editMessageText")
        .filter(({ chat_id }) => chat_id === telegramGroup);
      expect(edits.map(({ message_id }) => message_id)).toEqual([500, 500]);
      expect(edits[1]?.text).toContain("Working on the approved issue.");
      for (const [index, chatId] of [telegramA, telegramGroup].entries())
        fake.push({
          update_id: index + 2,
          message: telegramMessage(chatId, 999, { text: `${askId} 1` }),
        });
      await fake.handled(3);
      const feedback = fake.only("sendMessage").slice(1);
      expect(feedback.map(({ chat_id }) => chat_id)).toEqual([telegramA]);
      expect(feedback[0]?.text).toContain("Already answered");
      expect(rows(f.db, "ask_answers")).toHaveLength(1);
      expect(fake.only("getMe")).toHaveLength(1);
      expect(fake.maxActivePolls).toBe(1);
      expect(fake.activePolls).toBe(1);
      const poll = timers.mock.calls.findLastIndex(([, ms]) => ms === 40_000);
      pollTimer = timers.mock.results[poll]?.value;
      expect(pollTimer).toBeDefined();
    } finally {
      process.emit("SIGTERM");
      process.emit("SIGINT");
      try {
        await run;
        if (pollTimer !== undefined)
          expect(cleared).toHaveBeenCalledWith(pollTimer);
      } finally {
        timers.mockRestore();
        cleared.mockRestore();
      }
    }
    expect(await run).toBe(0);
    expect(entry.stderr).toEqual([]);
    expect(fake.activePolls).toBe(0);
    expect(fake.cancelledPolls).toBe(1);
    expect(process.listenerCount("SIGTERM")).toBe(listeners);
  },
  timeout,
);

test(
  "W2 a missing or blank Telegram token gives a typed startup refusal",
  async () => {
    const f = await telegramHub();
    const entry = mainFixture();
    for (const token of [undefined, " \t "])
      await expect(
        runService(f.config, () => token, entry.services),
      ).rejects.toMatchObject({
        kind: "telegramToken",
        message: "Missing TELEGRAM_BOT_TOKEN",
      });
    expect(entry.calls).toEqual([]);
  },
  timeout,
);

test(
  "W10 signals cancel the Telegram handshake before polling starts",
  async () => {
    const f = await telegramHub();
    const fake = fakeTelegram();
    const entered = Promise.withResolvers<AbortSignal>();
    const response = Promise.withResolvers<Response>();
    const entry = telegramEntry(f, (url, init) => {
      if (!url.pathname.endsWith("/getWebhookInfo"))
        return fake.fetch(url, init);
      const signal = init.signal;
      if (!signal) throw new Error("Expected a startup abort signal");
      signal.addEventListener("abort", () => response.reject(signal.reason), {
        once: true,
      });
      entered.resolve(signal);
      return response.promise;
    });
    const run = entry.run(["serve"], tokenEnv);
    try {
      const signal = await Promise.race([entered.promise, run]);
      if (typeof signal === "number") throw new Error(entry.stderr.join(""));
      process.emit("SIGTERM");
      await nextTurn();
      expect(signal.aborted).toBe(true);
      expect(await run).toBe(0);
      expect(entry.stderr).toEqual([]);
      expect(fake.only("getMe")).toEqual([]);
      expect(fake.only("getUpdates")).toEqual([]);
    } finally {
      response.resolve(telegramOk({ url: "" }));
      process.emit("SIGTERM");
      await run;
    }
  },
  timeout,
);

test(
  "W3 Telegram refuses missing, empty and unmapped people before constructing a port",
  async () => {
    const f = await telegramHub();
    const entry = mainFixture({ loadConfig });
    const missingMappings = [undefined, [], [a]];
    for (const people of missingMappings) {
      f.save({ people });
      expect(await entry.run(["serve", "--config", f.path], tokenEnv)).toBe(1);
    }
    expect(entry.calls).toEqual([]);
    expect(entry.stderr).toEqual(
      missingMappings.map(
        () => "Telegram requires at least one mapped person\n",
      ),
    );
  },
  timeout,
);

test(
  "W5 the exact token is absent from config and startup failure output",
  async () => {
    const f = await telegramHub();
    const createChatPort = mock(() => {
      throw new Error(fixtureTelegramToken);
    });
    const entry = mainFixture({
      loadConfig,
      createChatPort,
      loadCore: () =>
        Promise.resolve({
          createHubCore,
          nullTracker,
          openHubDb: () => ({ ...f.db, close() {} }),
        }),
    });
    const argv = ["serve", "--config", f.path];
    f.save({ [fixtureTelegramToken]: fixtureTelegramToken });
    expect(await entry.run(argv, tokenEnv)).toBe(1);
    f.save();
    expect(await entry.run(argv, tokenEnv)).toBe(1);
    expect(createChatPort).toHaveBeenCalledTimes(1);
    expect(entry.stderr).toEqual([
      "could not load hub configuration\n",
      "could not run hub service\n",
    ]);
    expect(JSON.stringify([entry.stdout, entry.stderr])).not.toContain(
      fixtureTelegramToken,
    );
  },
  timeout,
);

test(
  "W8 the shipped main factory posts a Telegram summary to the configured chat",
  async () => {
    const f = await telegramHub();
    const fake = fakeTelegram();
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        (...[input, init]: Parameters<typeof fetch>) =>
          fake.fetch(
            new URL(input instanceof Request ? input.url : input),
            init ?? {},
          ),
        { preconnect() {} },
      ),
    );
    const stdout = spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      expect(
        await main(
          ["summary", "post", "--config", f.path, "--project", p1],
          tokenEnv,
        ),
      ).toBe(0);
    } finally {
      stdout.mockRestore();
      fetchSpy.mockRestore();
    }
    expect(fake.only("sendMessage")).toMatchObject([
      { chat_id: telegramGroup },
    ]);
    expect(fake.only("getUpdates")).toEqual([]);
  },
  timeout,
);
