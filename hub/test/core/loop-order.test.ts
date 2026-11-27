import { expect, test } from "bun:test";
import { parseMessageRef } from "../../src/chat/inbound.ts";
import { ChatWriteFailure } from "../../src/contract/chat.ts";
import { LIMITS } from "../../src/contract/mcp.ts";
import { createCoreBase, createCoreContext } from "../../src/core/core.ts";
import { createEffectWorker } from "../../src/core/effects.ts";
import {
  baseFixture,
  channel,
  unknownUser,
  type BaseFixture,
} from "./base-fixture.ts";
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

async function sweepHistory(f: BaseFixture) {
  const worker = createEffectWorker(f.context, () => () => {});
  await worker.start();
  await worker.close();
}

function blockProjection(f: BaseFixture) {
  f.db.exec(
    "CREATE TRIGGER block_projection BEFORE INSERT ON thread_messages WHEN NEW.kind = 'agent' BEGIN SELECT RAISE(ABORT, 'injected projection failure'); END",
  );
  return () => f.db.exec("DROP TRIGGER block_projection");
}

function replayRun(r: ReturnType<typeof run>) {
  return run(
    { ...r.f, core: createCoreBase(createCoreContext(r.f.deps)) },
    r.session,
    r.conversationId,
  );
}

function loseNextSlackResponse(f: BaseFixture) {
  const accepted: string[] = [];
  const post = f.chat.postText.bind(f.chat);
  f.chat.postText = async (...args) => {
    f.chat.postText = post;
    accepted.push((await post(...args)).chatMessageId);
    throw new ChatWriteFailure("unknown");
  };
  return accepted;
}

test.each([false, true])(
  "forge-2024 a member reopens a paused run (with retention pressure: %s)",
  async (sweep) => {
    const r = await slackRun(1001, 1012);
    const { f } = r;
    await r.post(LIMITS.agentRunMax);
    expect(r.notices()).toBe(1);
    if (sweep) {
      for (let i = 1; i <= LIMITS.threadKeep; i++)
        await f.follow(ts(i), {
          chatThreadId: thread,
          slackUserId: unknownUser,
          mentionsBot: false,
        });
      expect(f.rows("thread_messages WHERE kind = 'outsider'")).toHaveLength(
        LIMITS.threadKeep,
      );
      await sweepHistory(f);
      expect(f.rows("thread_messages")).toHaveLength(LIMITS.threadKeep);
    }
    await r.paused();
    expect(r.notices()).toBe(1);
    await r.member(ts(1012));
    await r.post(LIMITS.agentRunMax - 1);
    expect(r.notices()).toBe(1);
    await r.post(1);
    await r.paused();
    expect(r.notices()).toBe(2);
  },
  timeout,
);

test(
  "forge-2024 age pruning preserves a partial run and still removes old outsider history",
  async () => {
    const r = await slackRun(2);
    const { f } = r;
    await r.post(LIMITS.agentRunMax - 1);
    await f.follow(ts(1), {
      chatThreadId: thread,
      slackUserId: unknownUser,
      mentionsBot: false,
    });
    f.advance((LIMITS.threadKeepDays + 1) * 86_400_000);
    await sweepHistory(f);
    expect(f.rows("thread_messages WHERE kind = 'outsider'")).toHaveLength(0);
    await r.post(1);
    await r.paused();
    expect(r.notices()).toBe(1);
  },
  timeout,
);

test(
  "forge-2024 replay of an unknown outcome settled before a recorded member does not count in the next run",
  async () => {
    const r = await slackRun(1, 2);
    const { f } = r;
    const unblock = blockProjection(f);
    const accepted = loseNextSlackResponse(f);
    expect(await r.reply("post with a lost response")).toMatchObject({
      ok: false,
      error: { retry: "reconcile_first" },
    });
    expect(accepted).toEqual([ts(1)]);
    await r.member(ts(2));
    expect(f.rows("meta WHERE key LIKE 'agent-post:%'")).toHaveLength(1);
    unblock();
    const recovered = replayRun(r);
    expect(f.rows("meta WHERE key LIKE 'agent-post:%'")).toHaveLength(0);
    expect(
      f.rows("thread_messages WHERE chat_message_id LIKE 'unconfirmed:%'"),
    ).toHaveLength(1);
    await recovered.post(LIMITS.agentRunMax - 1);
    expect(recovered.notices()).toBe(0);
    await recovered.post(1);
    await recovered.paused();
    expect(recovered.notices()).toBe(1);
  },
  timeout,
);

test(
  "forge-2024 replay keeps charging the unknown when a confirmed predecessor proves the member is older",
  async () => {
    const r = await slackRun(2);
    await r.post(1);
    const { f } = r;
    const unblock = blockProjection(f);
    const accepted = loseNextSlackResponse(f);
    expect(await r.reply("post with a lost response")).toMatchObject({
      ok: false,
      error: { retry: "reconcile_first" },
    });
    expect(accepted).toEqual([ts(3)]);
    await r.member(ts(1));
    unblock();
    const recovered = replayRun(r);
    await recovered.post(LIMITS.agentRunMax - 2);
    await recovered.paused();
    expect(recovered.notices()).toBe(1);
  },
  timeout,
);

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
