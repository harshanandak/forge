import { expect, test } from "bun:test";
import { parseMessageRef } from "../../src/chat/inbound.ts";
import { LIMITS } from "../../src/contract/mcp.ts";
import { createCoreBase, createCoreContext } from "../../src/core/core.ts";
import { baseFixture, channel, type BaseFixture } from "./base-fixture.ts";
import { p1, value } from "./fixture.ts";
import { slackB } from "./fakes.ts";

const timeout = 30_000;
const pause = "Paused: the agents need a person to reply.";
const ts = (index: number) => "1795760000." + String(index).padStart(6, "0");
const thread = "slack:" + channel + ":" + ts(0);

function useSlackPosts(
  f: BaseFixture,
  next: number,
  reserved?: number,
  stamp = ts,
) {
  const post = f.chat.postText.bind(f.chat);
  f.chat.postText = async (target, text, options) => {
    const ref = await post(target, text, options);
    if (next === reserved) next++;
    return { ...ref, chatThreadId: thread, chatMessageId: stamp(next++) };
  };
}

function run(f: BaseFixture, session: string, conversationId: string) {
  const reply = (text: string) =>
    f.core.reply(f.caller(), { sessionId: session, conversationId, text });
  return {
    f,
    session,
    conversationId,
    reply,
    post: async (count: number) => {
      for (let i = 0; i < count; i++)
        expect(await reply("agent post")).toMatchObject({ ok: true });
    },
    paused: async () =>
      expect(await reply("blocked")).toMatchObject({
        ok: false,
        error: { code: "CONVERSATION_PAUSED" },
      }),
    notices: () => f.posts().filter((text) => text === pause).length,
    member: async (id: string) => {
      await f.follow(id, {
        chatThreadId: thread,
        slackUserId: slackB,
        mentionsBot: false,
      });
      expect(
        f.rows("thread_messages WHERE chat_message_id = ?", "kind", id),
      ).toEqual([{ kind: "person" }]);
    },
  };
}

async function slackRun(
  first: number,
  reserved?: number,
  stamp = ts,
  clock = 95_760_000_000,
) {
  const f = await baseFixture({ ring: true });
  f.advance(clock);
  const alpha = f.bind();
  await f.emit(ts(0), { chatThreadId: thread });
  useSlackPosts(f, first, reserved, stamp);
  return run(
    f,
    alpha.sessionId,
    f.read(alpha.sessionId).items[0]!.conversationId!,
  );
}

test.each([
  ["C1", false],
  ["R1", true],
] as const)(
  "forge-1988 %s ten posts pause even after an older member is delivered",
  async (_row, late) => {
    const r = await slackRun(2);
    await r.post(LIMITS.agentRunMax);
    expect(r.notices()).toBe(1);
    if (late) await r.member(ts(1));
    await r.paused();
  },
  timeout,
);

test(
  "forge-1988 R2 an adopted older root stays before the member reply",
  async () => {
    const f = await baseFixture({ ring: true });
    const alpha = f.bind();
    await f.follow(ts(2), { chatThreadId: thread });
    useSlackPosts(f, 1, 2);
    const root = value(
      await f.core.reply(f.caller(), {
        sessionId: alpha.sessionId,
        projectId: p1,
        text: "adopted root",
      }),
    );
    expect(root.chatMessageId).toBe(ts(1));
    const r = run(f, alpha.sessionId, root.conversationId);
    await r.post(LIMITS.agentRunMax - 1);
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
    expect(r.notices()).toBe(0);
  },
  timeout,
);

test.each([
  ["R3", 2, false, false],
  ["G1", 1, false, false],
  ["G2", 2, true, false],
  ["G1 delayed", 2, false, true],
] as const)(
  "forge-1988 %s an unknown without an earlier Slack fence stays charged",
  async (_row, settleMs, legacy, delayed) => {
    const r = await slackRun(2001, undefined, ts, 95_760_000_001);
    const { f } = r;
    const at = f.now();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.chat.nextWrite = { kind: "unknown", until: release.promise };
    const post = f.chat.postText.bind(f.chat);
    f.chat.postText = (...args) => {
      f.chat.postText = post;
      const pending = post(...args);
      entered.resolve();
      return pending;
    };
    const attempt = r.reply("in flight");
    await entered.promise;
    try {
      if (!delayed) await r.member(ts(1500));
      f.advance(settleMs - 1);
    } finally {
      release.resolve();
    }
    await attempt;
    if (delayed) await r.member(ts(1500));
    if (legacy)
      f.db
        .prepare(
          "UPDATE thread_messages SET created_at = ? WHERE chat_message_id LIKE 'unconfirmed:%'",
        )
        .run(at);
    expect(
      f.rows(
        "thread_messages WHERE chat_message_id LIKE 'unconfirmed:%'",
        "kind",
      ),
    ).toEqual([{ kind: "agent" }]);
    await r.post(LIMITS.agentRunMax - 1);
    await r.paused();
    expect(r.notices()).toBe(1);
  },
  timeout,
);

test(
  "forge-1988 G3 recovery preserves the original timestamp and Slack evidence clears the unknown",
  async () => {
    const r = await slackRun(99, 100);
    const { f } = r;
    const at = f.now();
    f.db.exec(
      "CREATE TRIGGER fail_projection BEFORE INSERT ON thread_messages WHEN NEW.kind = 'agent' BEGIN SELECT RAISE(ABORT, 'injected projection failure'); END",
    );
    f.chat.nextWrite = { kind: "unknown" };
    await r.reply("lost write");
    expect(f.rows("meta WHERE key LIKE 'agent-post:%'")).toHaveLength(1);
    f.db.exec("DROP TRIGGER fail_projection");
    f.advance(5_000);
    createCoreContext(f.deps);
    expect(f.rows("meta WHERE key LIKE 'agent-post:%'")).toHaveLength(0);
    expect(
      f.col(
        "thread_messages WHERE chat_message_id LIKE 'unconfirmed:%'",
        "created_at",
      ),
    ).toEqual([at]);
    await r.post(1);
    await r.member(ts(100));
    await r.post(LIMITS.agentRunMax - 1);
    expect(r.notices()).toBe(0);
    await r.post(1);
    expect(r.notices()).toBe(1);
  },
  timeout,
);

test(
  "forge-1988 G6 a pause notice deduplicates across restart with the hub clock ahead",
  async () => {
    const r = await slackRun(1, undefined, ts, 95_760_005_000);
    for (let i = 0; i < LIMITS.agentRunMax; i++) {
      r.f.chat.nextWrite = { kind: "unknown" };
      await r.reply("lost post");
    }
    expect(r.notices()).toBe(1);
    await r.paused();
    const fresh = createCoreContext(r.f.deps);
    expect(
      await createCoreBase(fresh).reply(r.f.caller(), {
        sessionId: r.session,
        conversationId: r.conversationId,
        text: "blocked after restart",
      }),
    ).toMatchObject({ ok: false, error: { code: "CONVERSATION_PAUSED" } });
    expect(r.notices()).toBe(1);
  },
  timeout,
);

test(
  "forge-1988 G7 a run reset by a late person earns a fresh notice at ten",
  async () => {
    const r = await slackRun(1, 10);
    await r.post(LIMITS.agentRunMax);
    expect(r.notices()).toBe(1);
    expect(
      r.f.col(
        "thread_messages WHERE kind = 'agent' ORDER BY seq",
        "chat_message_id",
      ),
    ).toEqual([
      ...Array.from({ length: LIMITS.agentRunMax - 1 }, (_, i) => ts(i + 1)),
      ts(11),
    ]);
    await r.member(ts(10));
    await r.post(LIMITS.agentRunMax - 2);
    expect(r.notices()).toBe(1);
    await r.post(1);
    expect(r.notices()).toBe(2);
  },
  timeout,
);

test(
  "forge-1988 G8 accepted leading-zero seconds compare numerically",
  async () => {
    const r = await slackRun(
      1,
      undefined,
      (index) => "1795760001." + String(index).padStart(6, "0"),
    );
    const id = "01795760000.000100";
    expect(parseMessageRef(thread, id)?.chatMessageId).toBe(id);
    await r.member(id);
    await r.post(LIMITS.agentRunMax);
    expect(r.notices()).toBe(1);
    await r.paused();
  },
  timeout,
);

test(
  "forge-1988 G9 a reply during the previous notice still earns a fresh notice at ten",
  async () => {
    const r = await slackRun(1, 11);
    await r.post(LIMITS.agentRunMax - 1);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { f } = r;
    const post = f.chat.postText.bind(f.chat);
    f.chat.postText = (...args) => {
      if (args[1] === pause) {
        f.chat.postText = post;
        f.chat.nextWrite = { kind: "delay", until: release.promise };
        entered.resolve();
      }
      return post(...args);
    };
    const tenth = r.post(1);
    await entered.promise;
    try {
      await r.member(ts(11));
    } finally {
      release.resolve();
    }
    await tenth;
    expect(r.notices()).toBe(1);
    await r.post(LIMITS.agentRunMax - 1);
    expect(r.notices()).toBe(1);
    await r.post(1);
    await r.paused();
    expect(r.notices()).toBe(2);
  },
  timeout,
);
