import { expect, test } from "bun:test";
import { LIMITS } from "../../src/contract/mcp.ts";
import { baseFixture, channel, type BaseFixture } from "./base-fixture.ts";
import { p1, value } from "./fixture.ts";
import { slackB } from "./fakes.ts";

const timeout = 30_000;
const pause = "Paused: the agents need a person to reply.";
const ts = (index: number) => "1795760000." + String(index).padStart(6, "0");
const orderThread = "slack:" + channel + ":" + ts(0);

function useSlackPosts(
  f: BaseFixture,
  first: number,
  reserved: readonly number[] = [],
  format: (index: number) => string = ts,
) {
  let next = first;
  const stamp = () => {
    while (reserved.includes(next)) next += 1;
    return format(next++);
  };
  const post = f.chat.postText.bind(f.chat);
  f.chat.postText = async (target, text, options) => {
    const ref = await post(target, text, options);
    return {
      ...ref,
      chatThreadId:
        target.kind === "thread" ? target.chatThreadId : orderThread,
      chatMessageId: stamp(),
    };
  };
}

function holdPost(f: BaseFixture) {
  const enter = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const post = f.chat.postText.bind(f.chat);
  f.chat.postText = async (...args) => {
    f.chat.postText = post;
    enter.resolve();
    await release.promise;
    f.chat.nextWrite = { kind: "unknown" };
    return post(...args);
  };
  return { entered: enter.promise, release: release.resolve };
}

function mkReply(f: BaseFixture, sessionId: string, conversationId: string) {
  return (text: string) =>
    f.core.reply(f.caller(), { sessionId, conversationId, text });
}

test(
  "forge-1988 R1 a delayed older member post does not reopen a paused run",
  async () => {
    const f = await baseFixture();
    const alpha = f.bind();
    useSlackPosts(f, 2);
    await f.emit(ts(0), { chatThreadId: orderThread });
    const conversationId = f.read(alpha.sessionId).items[0]!.conversationId!;
    const reply = mkReply(f, alpha.sessionId, conversationId);
    for (let index = 0; index < LIMITS.agentRunMax; index++)
      value(await reply("reply " + index));
    expect(f.posts().filter((text) => text === pause)).toHaveLength(1);
    await f.follow(ts(1), {
      chatThreadId: orderThread,
      slackUserId: slackB,
      mentionsBot: false,
    });
    expect(await reply("eleventh")).toMatchObject({
      ok: false,
      error: { code: "CONVERSATION_PAUSED" },
    });
  },
  timeout,
);

test(
  "forge-1988 R2 an adopted older root stays before the member reply",
  async () => {
    const f = await baseFixture();
    const alpha = f.bind();
    useSlackPosts(f, 1, [2]);
    await f.follow(ts(2), { chatThreadId: orderThread });
    const root = value(
      await f.core.reply(f.caller(), {
        sessionId: alpha.sessionId,
        projectId: p1,
        text: "adopted root",
      }),
    );
    expect(root.chatMessageId).toBe(ts(1));
    expect(
      f.col(
        "thread_messages WHERE kind IN ('agent','person') ORDER BY seq",
        "chat_message_id",
      ),
    ).toEqual([ts(2), ts(1)]);
    const reply = mkReply(f, alpha.sessionId, root.conversationId);
    for (let index = 0; index < LIMITS.agentRunMax - 1; index++)
      value(await reply("reply " + index));
    expect(
      f.col(
        "thread_messages WHERE kind IN ('agent','person') ORDER BY seq",
        "chat_message_id",
      ),
    ).toEqual([
      ts(2),
      ts(1),
      ...Array.from({ length: LIMITS.agentRunMax - 1 }, (_, i) => ts(i + 3)),
    ]);
    expect(f.posts().filter((text) => text === pause)).toHaveLength(0);
  },
  timeout,
);

test(
  "forge-1988 C1 ten in-order agent posts still pause the thread",
  async () => {
    const f = await baseFixture();
    const alpha = f.bind();
    useSlackPosts(f, 1);
    await f.emit(ts(0), { chatThreadId: orderThread });
    const conversationId = f.read(alpha.sessionId).items[0]!.conversationId!;
    const reply = mkReply(f, alpha.sessionId, conversationId);
    for (let index = 0; index < LIMITS.agentRunMax; index++)
      value(await reply("reply " + index));
    expect(f.posts().filter((text) => text === pause)).toHaveLength(1);
    expect(await reply("eleventh")).toMatchObject({
      ok: false,
      error: { code: "CONVERSATION_PAUSED" },
    });
  },
  timeout,
);

test(
  "forge-1988 R3 an unknown-outcome post settled after a member counts in the run",
  async () => {
    const f = await baseFixture();
    const alpha = f.bind();
    useSlackPosts(f, 2001);
    f.advance(95_760_000_000);
    await f.emit(ts(0), { chatThreadId: orderThread });
    const conversationId = f.read(alpha.sessionId).items[0]!.conversationId!;
    const reply = mkReply(f, alpha.sessionId, conversationId);
    const enter = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const post = f.chat.postText.bind(f.chat);
    f.chat.postText = async (...args) => {
      f.chat.postText = post;
      enter.resolve();
      await release.promise;
      f.chat.nextWrite = { kind: "unknown" };
      return post(...args);
    };
    f.advance(1);
    const inFlight = reply("in flight");
    await enter.promise;
    await f.follow(ts(1500), {
      chatThreadId: orderThread,
      slackUserId: slackB,
      mentionsBot: false,
    });
    f.advance(1);
    release.resolve();
    await inFlight;
    for (let index = 0; index < LIMITS.agentRunMax - 1; index++)
      value(await reply("reply " + index));
    expect(f.posts().filter((text) => text === pause)).toHaveLength(1);
    expect(await reply("eleventh")).toMatchObject({
      ok: false,
      error: { code: "CONVERSATION_PAUSED" },
    });
    expect(f.posts().filter((text) => text === pause)).toHaveLength(1);
  },
  timeout,
);

test(
  "forge-1988 G1 an unknown settled after a member stays charged whatever the clock",
  async () => {
    const f = await baseFixture();
    const alpha = f.bind();
    useSlackPosts(f, 2001);
    f.advance(95_760_000_001);
    await f.emit(ts(0), { chatThreadId: orderThread });
    const conversationId = f.read(alpha.sessionId).items[0]!.conversationId!;
    const reply = mkReply(f, alpha.sessionId, conversationId);
    const held = holdPost(f);
    const inFlight = reply("in flight");
    await held.entered;
    await f.follow(ts(1500), {
      chatThreadId: orderThread,
      slackUserId: slackB,
      mentionsBot: false,
    });
    held.release();
    await inFlight;
    for (let index = 0; index < LIMITS.agentRunMax - 1; index++)
      value(await reply("reply " + index));
    expect(await reply("eleventh")).toMatchObject({
      ok: false,
      error: { code: "CONVERSATION_PAUSED" },
    });
    expect(f.posts().filter((text) => text === pause)).toHaveLength(1);
  },
  timeout,
);

test(
  "forge-1988 G2 an upgraded unknown row stays charged whatever its created_at",
  async () => {
    const f = await baseFixture();
    const alpha = f.bind();
    useSlackPosts(f, 2001);
    f.advance(95_760_000_001);
    await f.emit(ts(0), { chatThreadId: orderThread });
    const conversationId = f.read(alpha.sessionId).items[0]!.conversationId!;
    const reply = mkReply(f, alpha.sessionId, conversationId);
    const held = holdPost(f);
    const inFlight = reply("in flight");
    await held.entered;
    await f.follow(ts(1500), {
      chatThreadId: orderThread,
      slackUserId: slackB,
      mentionsBot: false,
    });
    f.advance(1);
    held.release();
    await inFlight;
    f.db
      .prepare(
        "UPDATE thread_messages SET created_at = 1795760000001 WHERE chat_message_id LIKE 'unconfirmed:%'",
      )
      .run();
    for (let index = 0; index < LIMITS.agentRunMax - 1; index++)
      value(await reply("reply " + index));
    expect(await reply("eleventh")).toMatchObject({
      ok: false,
      error: { code: "CONVERSATION_PAUSED" },
    });
    expect(f.posts().filter((text) => text === pause)).toHaveLength(1);
  },
  timeout,
);

test(
  "forge-1988 G3 a replayed unknown inserted before a delayed person does not false-pause",
  async () => {
    const f = await baseFixture();
    const alpha = f.bind();
    useSlackPosts(f, 2001);
    f.advance(95_760_000_005);
    await f.emit(ts(0), { chatThreadId: orderThread });
    const conversationId = f.read(alpha.sessionId).items[0]!.conversationId!;
    const reply = mkReply(f, alpha.sessionId, conversationId);
    f.chat.nextWrite = { kind: "unknown" };
    await reply("lost write");
    await f.follow(ts(100), {
      chatThreadId: orderThread,
      slackUserId: slackB,
      mentionsBot: false,
    });
    for (let index = 0; index < LIMITS.agentRunMax - 1; index++)
      value(await reply("reply " + index));
    expect(await reply("tenth")).toMatchObject({ ok: true });
  },
  timeout,
);

test(
  "forge-1988 G6 one pause notice suppresses repeats for its own run",
  async () => {
    const f = await baseFixture();
    const alpha = f.bind();
    useSlackPosts(f, 1);
    f.advance(95_760_005_000);
    await f.emit(ts(0), { chatThreadId: orderThread });
    const conversationId = f.read(alpha.sessionId).items[0]!.conversationId!;
    const reply = mkReply(f, alpha.sessionId, conversationId);
    for (let index = 0; index < LIMITS.agentRunMax; index++) {
      f.chat.nextWrite = { kind: "unknown" };
      await reply("lost " + index);
    }
    expect(f.posts().filter((text) => text === pause)).toHaveLength(1);
    for (let index = 0; index < 2; index++) await reply("blocked " + index);
    expect(f.posts().filter((text) => text === pause)).toHaveLength(1);
  },
  timeout,
);

test(
  "forge-1988 G7 a run reset by a late person earns a fresh notice at ten",
  async () => {
    const f = await baseFixture();
    const alpha = f.bind();
    useSlackPosts(f, 1, [10]);
    f.advance(95_760_000_000);
    await f.emit(ts(0), { chatThreadId: orderThread });
    const conversationId = f.read(alpha.sessionId).items[0]!.conversationId!;
    const reply = mkReply(f, alpha.sessionId, conversationId);
    for (let index = 0; index < LIMITS.agentRunMax; index++)
      value(await reply("reply " + index));
    expect(f.posts().filter((text) => text === pause)).toHaveLength(1);
    await f.follow(ts(10), {
      chatThreadId: orderThread,
      slackUserId: slackB,
      mentionsBot: false,
    });
    for (let index = 0; index < LIMITS.agentRunMax - 1; index++)
      value(await reply("again " + index));
    expect(f.posts().filter((text) => text === pause)).toHaveLength(2);
  },
  timeout,
);

test(
  "forge-1988 G8 leading-zero seconds compare numerically",
  async () => {
    const f = await baseFixture();
    const alpha = f.bind();
    useSlackPosts(
      f,
      1,
      [],
      (index) => "1795760001." + String(index).padStart(6, "0"),
    );
    f.advance(95_760_000_000);
    await f.emit(ts(0), { chatThreadId: orderThread });
    const conversationId = f.read(alpha.sessionId).items[0]!.conversationId!;
    const reply = mkReply(f, alpha.sessionId, conversationId);
    await f.follow("01795760000.000100", {
      chatThreadId: orderThread,
      slackUserId: slackB,
      mentionsBot: false,
    });
    for (let index = 0; index < LIMITS.agentRunMax; index++)
      value(await reply("reply " + index));
    expect(f.posts().filter((text) => text === pause)).toHaveLength(1);
    expect(await reply("eleventh")).toMatchObject({
      ok: false,
      error: { code: "CONVERSATION_PAUSED" },
    });
  },
  timeout,
);
