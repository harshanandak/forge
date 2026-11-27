import { expect, test } from "bun:test";
import { createHubCore, nullTracker } from "../../src/core/index.ts";
import { FakeChatPort } from "../fakes/fake-chat.ts";
import { channel, thread } from "./base-fixture.ts";
import { doorbellFake, refusal } from "./base-fakes.ts";
import {
  a,
  caller,
  configPeople,
  fixture,
  onFixtureCleanup,
  seedHost,
  value,
} from "./fixture.ts";
import { host, slackA } from "./fakes.ts";

const timeout = 30_000;

async function stopFixture() {
  const f = await fixture({ hooks: { enabled: true } });
  const chat = new FakeChatPort(f.config.slack.teamId);
  const core = createHubCore({
    ...f,
    chat,
    people: configPeople(f.config.people),
    doorbell: doorbellFake(false).port,
    tracker: nullTracker,
  });
  onFixtureCleanup(() => core.close());
  await core.start();
  seedHost(f.db);
  const binding = { host: "claude", hostSessionId: "stop-fixture" } as const;
  const { sessionId } = value(
    core.hookSession(host, { ...binding, source: "startup" }),
  );
  const stop = (text: string) => core.hookStop(host, { ...binding, text });
  async function owe(id: string, chatThreadId = thread) {
    await chat.emitMessage({
      eventKey: id,
      chatMessageId: id,
      chatThreadId,
      channelId: channel,
      slackUserId: slackA,
      userName: a.displayName,
      text: id,
      isBot: false,
      isDirect: false,
      mentionsBot: true,
    });
    const item = value(core.inbox(caller, { sessionId })).items.find(
      ({ text }) => text === id,
    );
    if (!item?.conversationId)
      throw new Error("Expected a delivered conversation");
    value(core.inbox(caller, { sessionId, ackItemIds: [item.itemId] }));
    return item.conversationId;
  }
  const posts = () =>
    chat.writes
      .filter(({ name }) => name === "postText")
      .map(({ args }) => args[1]);
  const rows = (sql: string) => f.db.prepare(sql).all();
  return { ...f, chat, core, host, binding, sessionId, stop, owe, posts, rows };
}

test(
  "H1 Stop posts once and skips a conversation already answered explicitly",
  async () => {
    const f = await stopFixture();
    await f.owe("first question");
    await f.owe("follow-up question");
    const permits = f.rows("SELECT * FROM permits");
    expect(value(await f.stop("Finished."))).toEqual({ result: "posted" });
    expect(value(await f.stop("Duplicate."))).toEqual({ result: "skipped" });
    const conversationId = await f.owe(
      "another question",
      "slack:C00000001:11.000001",
    );
    value(
      await f.core.reply(caller, {
        sessionId: f.sessionId,
        conversationId,
        text: "Explicit reply.",
      }),
    );
    expect(value(await f.stop("Already answered."))).toEqual({
      result: "skipped",
    });
    expect(f.posts()).toEqual([
      expect.stringContaining("Finished."),
      expect.stringContaining("Explicit reply."),
    ]);
    expect(f.rows("SELECT * FROM permits")).toEqual(permits);
  },
  timeout,
);

test(
  "H1 concurrent and repeated Stop calls skip an uncertain post",
  async () => {
    const f = await stopFixture();
    await f.owe("question");
    const release = Promise.withResolvers<void>();
    f.chat.nextWrite = { kind: "unknown", until: release.promise };
    const first = f.stop("Delivery uncertain.");
    try {
      expect(value(await f.stop("Concurrent duplicate."))).toEqual({
        result: "skipped",
      });
    } finally {
      release.resolve();
    }
    expect(refusal(await first)).toMatchObject({
      code: "CHAT_UNAVAILABLE",
      retry: "reconcile_first",
    });
    expect(value(await f.stop("Later duplicate."))).toEqual({
      result: "skipped",
    });
    expect(f.posts()).toEqual([expect.stringContaining("Delivery uncertain.")]);
  },
  timeout,
);

test(
  "H1 Stop skips after an in-flight explicit reply succeeds",
  async () => {
    const f = await stopFixture();
    const conversationId = await f.owe("question");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const post = f.chat.postText.bind(f.chat);
    f.chat.postText = (...args) => {
      entered.resolve();
      return post(...args);
    };
    f.chat.nextWrite = { kind: "delay", until: release.promise };
    const explicit = f.core.reply(caller, {
      sessionId: f.sessionId,
      conversationId,
      text: "Explicit reply.",
    });
    await Promise.race([entered.promise, explicit]);
    try {
      expect(f.posts()).toEqual([expect.stringContaining("Explicit reply.")]);
      const stop = f.stop("Automatic duplicate.");
      release.resolve();
      expect(value(await explicit).conversationId).toBe(conversationId);
      expect(value(await stop)).toEqual({ result: "skipped" });
      expect(f.posts()).toEqual([expect.stringContaining("Explicit reply.")]);
    } finally {
      release.resolve();
    }
  },
  timeout,
);

test(
  "H1 Stop leaves ambiguous conversations for explicit replies",
  async () => {
    const f = await stopFixture();
    await f.owe("first question");
    await f.owe("separate question", "slack:C00000001:11.000001");
    expect(value(await f.stop("Ambiguous answer."))).toEqual({
      result: "skipped",
    });
    expect(f.posts()).toEqual([]);
    expect(f.rows("SELECT answered FROM reply_owed")).toEqual([
      { answered: 0 },
      { answered: 0 },
    ]);
  },
  timeout,
);

test(
  "H2 a secret-shaped Stop answer is held without reaching chat or storage",
  async () => {
    const f = await stopFixture();
    await f.owe("question");
    const sensitive = "xoxb-" + "0".repeat(32);
    const result = await f.stop("a".repeat(3500) + sensitive);
    const recorded = [
      f.chat.calls,
      f.logged,
      f.rows("SELECT text FROM thread_messages"),
      f.rows("SELECT text FROM inbox_items"),
      f.rows("SELECT value FROM meta"),
      result,
    ];
    expect(JSON.stringify(recorded).includes(sensitive)).toBe(false);
    expect(value(result)).toEqual({ result: "held" });
    expect(f.posts()).toEqual([
      expect.stringContaining("looked like it contained a secret"),
    ]);
    expect(value(await f.stop("Try again."))).toEqual({ result: "skipped" });
  },
  timeout,
);

test(
  "H2 Stop refuses an unknown or foreign host binding without claiming replies",
  async () => {
    const f = await stopFixture();
    expect(value(await f.stop("Nothing owed."))).toEqual({ result: "skipped" });
    await f.owe("question");
    seedHost(f.db, "hst_other");
    const input = { ...f.binding, text: "Wrong binding." };
    for (const result of [
      await f.core.hookStop({ ...f.host, hostInstanceId: "hst_other" }, input),
      await f.core.hookStop(f.host, {
        ...input,
        hostSessionId: "unregistered",
      }),
      await f.core.hookStop(f.host, { ...input, host: "codex" }),
    ]) {
      expect(refusal(result)).toMatchObject({ code: "SESSION_UNKNOWN" });
    }
    expect(f.posts()).toEqual([]);
    expect(f.rows("SELECT session_id FROM sessions")).toEqual([
      { session_id: f.sessionId },
    ]);
    expect(f.rows("SELECT answered FROM reply_owed")).toEqual([
      { answered: 0 },
    ]);
    expect(value(await f.stop("Right binding."))).toEqual({ result: "posted" });
  },
  timeout,
);
