import { expect, test } from "bun:test";
import { setImmediate as nextTurn } from "node:timers/promises";
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
const secondThread = "slack:C00000001:11.000001";

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
  const owed = () =>
    rows("SELECT answered FROM reply_owed ORDER BY rowid").map(
      (row) => row.answered,
    );
  return { ...f, chat, core, binding, sessionId, stop, owe, posts, rows, owed };
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
    const conversationId = await f.owe("another question", secondThread);
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
  "H1 Stop restores only the newly claimed rows after a definite refusal",
  async () => {
    const f = await stopFixture();
    await f.owe("previous question");
    f.db.exec("UPDATE reply_owed SET answered = 1");
    await f.owe("new question");
    f.chat.nextWrite = { kind: "refused" };
    expect(refusal(await f.stop("First attempt."))).toMatchObject({
      code: "CHAT_UNAVAILABLE",
      retry: "safe",
    });
    expect(f.owed()).toEqual([1, 0]);
    expect(value(await f.stop("Recovered."))).toEqual({ result: "posted" });
    expect(f.owed()).toEqual([1, 1]);
    expect(f.posts()).toEqual([expect.stringContaining("Recovered.")]);
  },
  timeout,
);

test(
  "H1 a queued explicit reply answers the obligation restored by a refused Stop",
  async () => {
    const f = await stopFixture();
    const conversationId = await f.owe("question");
    const release = Promise.withResolvers<void>();
    const post = f.chat.postText.bind(f.chat);
    let automaticPending = false;
    f.chat.postText = async (...args) => {
      if (args[1].endsWith("Automatic answer.")) {
        automaticPending = true;
        await release.promise;
        f.chat.nextWrite = { kind: "refused" };
      }
      return post(...args);
    };
    const automatic = f.stop("Automatic answer.");
    await nextTurn();
    const queuedWhilePending = automaticPending;
    const explicit = f.core.reply(caller, {
      sessionId: f.sessionId,
      conversationId,
      text: "Explicit answer.",
    });
    release.resolve();
    expect(queuedWhilePending).toBe(true);
    expect(refusal(await automatic)).toMatchObject({
      code: "CHAT_UNAVAILABLE",
      retry: "safe",
    });
    expect(value(await explicit).conversationId).toBe(conversationId);
    const onePost = [expect.stringContaining("Explicit answer.")];
    expect(f.posts()).toEqual(onePost);
    expect(f.owed()).toEqual([1]);
    expect(value(await f.stop("Later automatic answer."))).toEqual({
      result: "skipped",
    });
    expect(f.posts()).toEqual(onePost);
  },
  timeout,
);

for (const outcome of ["transcript", "journal"]) {
  test(
    "H1 Stop skips an uncertain explicit reply recorded in the " + outcome,
    async () => {
      const f = await stopFixture();
      const conversationId = await f.owe("question");
      if (outcome === "journal")
        f.db
          .exec(`CREATE TRIGGER fail_agent_projection BEFORE INSERT ON thread_messages
          WHEN NEW.kind = 'agent' BEGIN SELECT RAISE(ABORT, 'injected projection failure'); END`);
      const release = Promise.withResolvers<void>();
      f.chat.nextWrite = { kind: "unknown", until: release.promise };
      const explicit = f.core.reply(caller, {
        sessionId: f.sessionId,
        conversationId,
        text: "Explicit reply.",
      });
      await nextTurn();
      const postsWhilePending = f.posts();
      const waiting = f.stop("Stop while explicit reply is pending.");
      release.resolve();
      expect(postsWhilePending).toHaveLength(1);
      expect(refusal(await explicit)).toMatchObject({
        code: "CHAT_UNAVAILABLE",
        retry: "reconcile_first",
      });
      const later = await f.stop("Stop after the uncertain reply.");
      const skipped = { ok: true, value: { result: "skipped" } } as const;
      expect([await waiting, later]).toEqual([skipped, skipped]);
      expect(f.owed()).toEqual([0]);
      expect(f.posts()).toEqual([expect.stringContaining("Explicit reply.")]);
    },
    timeout,
  );
}

test(
  "H1 Stop skips after an in-flight explicit reply succeeds",
  async () => {
    const f = await stopFixture();
    const conversationId = await f.owe("question");
    const release = Promise.withResolvers<void>();
    f.chat.nextWrite = { kind: "delay", until: release.promise };
    const explicit = f.core.reply(caller, {
      sessionId: f.sessionId,
      conversationId,
      text: "Explicit reply.",
    });
    await nextTurn();
    const postsWhilePending = f.posts();
    const stop = f.stop("Automatic duplicate.");
    const settled = await Promise.race([
      stop.then(() => true),
      nextTurn(false),
    ]);
    release.resolve();
    const onePost = [expect.stringContaining("Explicit reply.")];
    expect(postsWhilePending).toEqual(onePost);
    expect(settled).toBe(false);
    expect(value(await explicit).conversationId).toBe(conversationId);
    expect(value(await stop)).toEqual({ result: "skipped" });
    expect(f.posts()).toEqual(onePost);
  },
  timeout,
);

test(
  "H1 Stop leaves ambiguous conversations for explicit replies",
  async () => {
    const f = await stopFixture();
    await f.owe("first question");
    await f.owe("separate question", secondThread);
    expect(value(await f.stop("Ambiguous answer."))).toEqual({
      result: "skipped",
    });
    expect(f.posts()).toEqual([]);
    expect(f.owed()).toEqual([0, 0]);
  },
  timeout,
);

test(
  "H2 a secret-shaped Stop answer is held without reaching chat or storage",
  async () => {
    const f = await stopFixture();
    await f.owe("question");
    const start = "private-answer-start";
    const prefix = "xoxb-";
    const body = "0".repeat(32);
    const end = "private-answer-end";
    const result = await f.stop(
      start + "a".repeat(3500) + prefix + body + " " + end,
    );
    const recorded = JSON.stringify([
      f.chat.calls,
      f.logged,
      f.rows("SELECT text FROM thread_messages"),
      f.rows("SELECT text FROM inbox_items"),
      f.rows("SELECT value FROM meta"),
      result,
    ]);
    for (const fragment of [start, prefix, body, end])
      expect(recorded.includes(fragment)).toBe(false);
    expect(value(result)).toEqual({ result: "held" });
    expect(f.posts()).toEqual([
      a.displayName +
        "'s agent: The agent's final message looked like it contained a secret and was held.",
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
      await f.core.hookStop({ ...host, hostInstanceId: "hst_other" }, input),
      await f.core.hookStop(host, {
        ...input,
        hostSessionId: "unregistered",
      }),
      await f.core.hookStop(host, { ...input, host: "codex" }),
    ]) {
      expect(refusal(result)).toMatchObject({ code: "SESSION_UNKNOWN" });
    }
    expect(f.posts()).toEqual([]);
    expect(f.rows("SELECT session_id FROM sessions")).toEqual([
      { session_id: f.sessionId },
    ]);
    expect(f.owed()).toEqual([0]);
    expect(value(await f.stop("Right binding."))).toEqual({ result: "posted" });
  },
  timeout,
);
