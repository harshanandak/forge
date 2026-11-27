import { expect, test } from "bun:test";
import { SUMMARY_KEY_MARKER } from "../../src/contract/chat.ts";
import type { HubErrorCode } from "../../src/contract/errors.ts";
import {
  LIMITS,
  LONG_ANSWER_SEPARATOR,
  type ReplyInput,
} from "../../src/contract/mcp.ts";
import { createCoreBase, createCoreContext } from "../../src/core/core.ts";
import { enterThread } from "../../src/core/thread.ts";
import {
  baseFixture,
  bellFor,
  channel,
  seedThread,
  thread,
} from "./base-fixture.ts";
import { refusal } from "./base-fakes.ts";
import { a, b, configPeople, p1, value } from "./fixture.ts";
import { slackA, slackB } from "./fakes.ts";

const timeout = 30_000;
const c = { personId: "per_c", displayName: "Fixture Gamma" };

const replyFixture = async () => {
  const f = await baseFixture();
  const alpha = f.bind();
  const beta = f.bind(b);
  const gamma = f.bind(c);
  await f.emit("root");
  await f.dm("beta-dm", "Beta note", slackB);
  value(
    await f.core.send(f.caller(), {
      sessionId: alpha.sessionId,
      projectId: p1,
      toPersonId: b.personId,
      text: "Agent note",
    }),
  );
  const alphaItem = f.read(alpha.sessionId).items.find((i) => i.conversationId);
  const conv = alphaItem?.conversationId;
  expect(conv).toBeDefined();
  const betaItem = f
    .read(beta.sessionId, b)
    .items.find((i) => i.conversationId);
  const betaConv = betaItem?.conversationId;
  expect(betaConv).toBeDefined();
  return { f, alpha, beta, gamma, conv, betaConv };
};

test(
  "B1B-REPLY1 reply refuses when chat is off",
  async () => {
    const { f, alpha } = await replyFixture();
    const off = createCoreBase(
      createCoreContext({
        ...f.deps,
        config: { ...f.config, slack: { ...f.config.slack, mode: "off" } },
        people: configPeople(f.config.people),
      }),
    );
    const input = {
      sessionId: alpha.sessionId,
      conversationId: "con_one",
      text: "Hello",
    };
    expect(refusal(await off.reply(f.caller(), input)).code).toBe(
      "BLOCK_DISABLED",
    );
  },
  timeout,
);

test(
  "B1B-REPLY1 reply refuses bad callers, targets, modes and text",
  async () => {
    const { f, alpha, beta, conv } = await replyFixture();
    const deny = async (
      person: typeof a,
      sessionId: string,
      code: HubErrorCode,
      extra?: { conversationId?: string; projectId?: string },
      text = "Hi",
    ) =>
      expect(
        refusal(
          await f.core.reply(f.caller(person), { sessionId, text, ...extra }),
        ).code,
      ).toBe(code);
    const secretText = "note " + ["gh", "p_", "a".repeat(36)].join("");
    const markedText = "note " + SUMMARY_KEY_MARKER + " end";
    const tooLong = "x".repeat(LIMITS.replyText + 1);
    const said = { conversationId: conv! };
    await deny(a, beta.sessionId, "SESSION_NOT_YOURS", said);
    await deny(a, "ses_missing", "SESSION_UNKNOWN", said);
    await deny(a, alpha.sessionId, "INPUT_INVALID", { ...said, projectId: p1 });
    await deny(a, alpha.sessionId, "INPUT_INVALID");
    await deny(b, beta.sessionId, "REPLY_ONLY", { projectId: p1 });
    await deny(a, alpha.sessionId, "INPUT_INVALID", said, "");
    await deny(a, alpha.sessionId, "INPUT_INVALID", said, tooLong);
    await deny(a, alpha.sessionId, "SECRET_IN_TEXT", said, secretText);
    await deny(a, alpha.sessionId, "INPUT_INVALID", said, markedText);
  },
  timeout,
);

test(
  "OW1.reply reply refuses unknown, foreign and paused conversations",
  async () => {
    const { f, alpha, gamma, conv, betaConv } = await replyFixture();
    for (let index = 0; index < LIMITS.agentRunMax; index++)
      seedThread(f, "a" + index, "r", "agent", a.personId, alpha.sessionId);
    const before = f.rows("inbox_items");
    const writes = f.chat.writes.length;
    const refuse = async (
      person: typeof a,
      sessionId: string,
      id: string,
      code: string,
    ) =>
      expect(
        refusal(
          await f.core.reply(f.caller(person), {
            sessionId,
            conversationId: id,
            text: "Hello",
          }),
        ),
      ).toMatchObject({ code, retry: "never" });
    await refuse(a, alpha.sessionId, "con_missing", "CONVERSATION_UNKNOWN");
    await refuse(a, alpha.sessionId, betaConv!, "CONVERSATION_NOT_YOURS");
    await refuse(c, gamma.sessionId, betaConv!, "CONVERSATION_NOT_YOURS");
    await refuse(a, alpha.sessionId, conv!, "CONVERSATION_PAUSED");
    expect(f.rows("inbox_items")).toEqual(before);
    expect(f.chat.writes.slice(writes)).toEqual([
      {
        name: "postText",
        args: [
          { kind: "thread", chatThreadId: thread },
          "Paused: the agents need a person to reply.",
          undefined,
        ],
      },
    ]);
  },
  timeout,
);

test(
  "OW1.reply reply refuses a conversation in a project the owner left",
  async () => {
    const { f, alpha, conv } = await replyFixture();
    const before = f.rows("inbox_items");
    const writes = f.chat.writes.length;
    const removed = createCoreBase(
      createCoreContext({
        ...f.deps,
        config: {
          ...f.config,
          projects: f.config.projects.map((project) =>
            project.projectId === p1
              ? {
                  ...project,
                  memberIds: project.memberIds.filter(
                    (id) => id !== a.personId,
                  ),
                }
              : project,
          ),
        },
        people: configPeople(f.config.people),
      }),
    );
    expect(
      refusal(
        await removed.reply(f.caller(), {
          sessionId: alpha.sessionId,
          conversationId: conv!,
          text: "Hello thread",
        }),
      ),
    ).toMatchObject({ code: "CONVERSATION_NOT_YOURS", retry: "never" });
    expect(f.rows("inbox_items")).toEqual(before);
    expect(f.chat.writes).toHaveLength(writes);
  },
  timeout,
);

test(
  "B1B-REPLY1 reply posts once per call in reply-only and normal sessions",
  async () => {
    const { f, alpha, beta, conv, betaConv } = await replyFixture();
    expect(f.read(beta.sessionId, b).mode).toBe("reply_only");
    for (const [person, sessionId, conversationId] of [
      [b, beta.sessionId, betaConv!],
      [a, alpha.sessionId, conv!],
    ] as const) {
      const out = value(
        await f.core.reply(f.caller(person), {
          sessionId,
          conversationId,
          text: "Hello thread",
        }),
      );
      expect(out.conversationId).toBe(conversationId);
    }
    expect(f.posts()).toHaveLength(2);
    expect(f.posts()[0]).toContain("Hello thread");
    expect(f.posts()[1]).toContain("Hello thread");
  },
  timeout,
);

test(
  "Z1 reply maps write failures without retrying",
  async () => {
    const { f, alpha, conv } = await replyFixture();
    const input = {
      sessionId: alpha.sessionId,
      conversationId: conv!,
      text: "Hello thread",
    };
    const attempts = () =>
      f.chat.calls.filter((call) => call.name === "postText").length;
    f.chat.nextWrite = { kind: "refused", reason: "not_in_channel" };
    expect(refusal(await f.core.reply(f.caller(), input))).toMatchObject({
      code: "CHAT_UNAVAILABLE",
      retry: "safe",
    });
    expect(attempts()).toBe(1);
    f.chat.nextWrite = { kind: "unknown" };
    const error = refusal(await f.core.reply(f.caller(), input));
    expect(error).toMatchObject({
      code: "CHAT_UNAVAILABLE",
      retry: "reconcile_first",
    });
    expect(error.repair).toContain("thread");
    expect(
      (error as unknown as { conversationId?: string }).conversationId,
    ).toBe(conv);
    expect(attempts()).toBe(2);
  },
  timeout,
);

test(
  "AD5 reply labels from Forge identity, prefixes the asker, ignores caller fields",
  async () => {
    const f = await baseFixture({ bells: [bellFor(b.personId, "beta")] });
    const beta = f.bind(b, "bound-b", "beta");
    await f.emit("ask-beta", { mentionedSlackUserIds: [slackB] });
    const conv = f.read(beta.sessionId, b).items[0]!.conversationId!;
    const out = value(
      await f.core.reply(f.caller(b), {
        sessionId: beta.sessionId,
        conversationId: conv,
        text: "Hello thread",
        agentLabel: "Fake",
        asker: slackB,
        prefix: "Fake:",
      } as ReplyInput),
    );
    expect(out.postedAs).toBe("Forge (Fixture Beta's agent)");
    expect(f.writes("postText")[0]!.args[2]).toEqual({
      agentLabel: "Forge (Fixture Beta's agent)",
    });
    expect(f.posts()[0]).toContain("answering <@" + slackA + ">:");
  },
  timeout,
);

test(
  "AD5 reply prefixes from the latest delivered item, ignoring undelivered ones",
  async () => {
    const f = await baseFixture();
    const alpha = f.bind();
    await f.emit("root");
    const conv = f.read(alpha.sessionId).items[0]!.conversationId!;
    f.advance(1);
    await f.follow("b-note", { slackUserId: slackB, mentionsBot: false });
    const say = (text: string) =>
      f.core.reply(f.caller(), {
        sessionId: alpha.sessionId,
        conversationId: conv,
        text,
      });
    await say("First reply");
    expect(f.posts()[0]).toContain("Fixture Alpha's agent:");
    expect(f.posts()[0]).not.toContain("answering");
    f.read(alpha.sessionId);
    await say("Second reply");
    expect(f.posts()).toHaveLength(2);
    expect(f.posts()[1]).toContain("answering <@" + slackB + ">:");
  },
  timeout,
);

test(
  "AD5 reply records the agent row for channel posts only",
  async () => {
    const { f, alpha, beta, conv, betaConv } = await replyFixture();
    const say = (
      who: typeof a,
      sid: string,
      cid: string,
      text = "Hello thread",
    ) =>
      f.core.reply(f.caller(who), {
        sessionId: sid,
        conversationId: cid,
        text,
      });
    const out = value(await say(a, alpha.sessionId, conv!));
    const agents = () =>
      f.rows(
        "thread_messages WHERE kind = 'agent'",
        "chat_thread_id,chat_message_id,person_id,session_id",
      );
    expect(agents()).toHaveLength(1);
    expect(agents()[0]).toMatchObject({
      chat_thread_id: thread,
      chat_message_id: out.chatMessageId,
      person_id: a.personId,
      session_id: alpha.sessionId,
    });
    await say(b, beta.sessionId, betaConv!, "Hello dm");
    f.chat.nextWrite = { kind: "refused", reason: "not_in_channel" };
    expect(
      refusal(await say(a, alpha.sessionId, conv!, "Hello again")).code,
    ).toBe("CHAT_UNAVAILABLE");
    expect(agents()).toHaveLength(1);
  },
  timeout,
);

test(
  "R6.reply projectId form posts a new top-level thread and binds the conversation",
  async () => {
    const f = await baseFixture();
    const alpha = f.bind();
    const input = {
      sessionId: alpha.sessionId,
      projectId: p1,
      text: "Hello channel",
    };
    const out = value(await f.core.reply(f.caller(), input));
    expect(f.writes("postText")).toHaveLength(1);
    expect(f.writes("postText")[0]!.args).toEqual([
      { kind: "channel", channelId: channel },
      "Fixture Alpha's agent: Hello channel",
      { agentLabel: "Forge (Fixture Alpha's agent)" },
    ]);
    const convs = f.rows("conversations");
    expect(convs).toHaveLength(1);
    expect(convs[0]).toMatchObject({
      conversation_id: out.conversationId,
      person_id: a.personId,
      project_id: p1,
      session_id: alpha.sessionId,
      chat_thread_id: channel,
      channel_id: channel,
    });
    const agents = f.rows("thread_messages WHERE kind = 'agent'");
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      chat_thread_id: channel,
      chat_message_id: out.chatMessageId,
      person_id: a.personId,
      session_id: alpha.sessionId,
    });
  },
  timeout,
);

test(
  "B1B-REPLY2 projectId form refusals",
  async () => {
    const { f, alpha, beta, gamma } = await replyFixture();
    const before = f.rows("conversations").length;
    const hi = (sessionId: string, projectId: string) => ({
      sessionId,
      projectId,
      text: "Hi",
    });
    for (const [person, sessionId, projectId, code] of [
      [b, beta.sessionId, p1, "REPLY_ONLY"],
      [a, alpha.sessionId, "prj_missing", "PROJECT_UNKNOWN"],
      [c, gamma.sessionId, p1, "NOT_PROJECT_MEMBER"],
    ] as const)
      expect(
        refusal(await f.core.reply(f.caller(person), hi(sessionId, projectId)))
          .code,
      ).toBe(code);
    expect(f.posts()).toEqual([]);
    expect(f.rows("conversations")).toHaveLength(before);
  },
  timeout,
);

test(
  "B1B-REPLY2 failed project posts create nothing and never retry",
  async () => {
    const f = await baseFixture();
    const alpha = f.bind();
    const input = {
      sessionId: alpha.sessionId,
      projectId: p1,
      text: "Hello channel",
    };
    const attempts = () =>
      f.chat.calls.filter((call) => call.name === "postText").length;
    f.chat.nextWrite = { kind: "refused", reason: "not_in_channel" };
    expect(refusal(await f.core.reply(f.caller(), input))).toMatchObject({
      code: "CHAT_UNAVAILABLE",
      retry: "safe",
    });
    expect(attempts()).toBe(1);
    expect(f.rows("conversations")).toEqual([]);
    f.chat.nextWrite = { kind: "unknown" };
    const error = refusal(await f.core.reply(f.caller(), input));
    expect(error).toMatchObject({
      code: "CHAT_UNAVAILABLE",
      retry: "reconcile_first",
    });
    expect(attempts()).toBe(2);
    expect(f.rows("conversations")).toEqual([]);
  },
  timeout,
);

test(
  "SA4 secret after the separator or past 1,200 refuses the whole answer",
  async () => {
    const secret = ["gh", "p_", "a".repeat(36)].join("");
    for (const text of [
      "Short summary\n" + LONG_ANSWER_SEPARATOR + "\n" + secret,
      "ok ".repeat(400) + secret,
    ]) {
      const f = await baseFixture();
      const alpha = f.bind();
      await f.emit("root");
      const first = f.read(alpha.sessionId).items[0]!;
      f.ack(alpha.sessionId, [first.itemId]);
      const conv = first.conversationId;
      if (!conv) throw new Error("Expected a Slack conversation ID");
      const error = refusal(
        await f.core.reply(f.caller(), {
          sessionId: alpha.sessionId,
          conversationId: conv,
          text,
        }),
      );
      expect(error.code).toBe("SECRET_IN_TEXT");
      expect(f.writes("createLongAnswer")).toEqual([]);
      expect(f.posts()).toEqual([]);
      expect(JSON.stringify(f.logged)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  },
  timeout,
);

test(
  "SA4 secret in a project-form answer creates no conversation, post or canvas",
  async () => {
    const f = await baseFixture();
    const alpha = f.bind();
    const secret = ["gh", "p_", "a".repeat(36)].join("");
    const before = f.rows("conversations").length;
    const error = refusal(
      await f.core.reply(f.caller(), {
        sessionId: alpha.sessionId,
        projectId: p1,
        text: "Short summary\n" + LONG_ANSWER_SEPARATOR + "\n" + secret,
      }),
    );
    expect(error.code).toBe("SECRET_IN_TEXT");
    expect(f.rows("conversations")).toHaveLength(before);
    expect(f.writes("createLongAnswer")).toEqual([]);
    expect(f.posts()).toEqual([]);
    expect(JSON.stringify(f.logged)).not.toContain(secret);
  },
  timeout,
);

test(
  "B1B-RACE1 inbound reply during a pending project post is adopted",
  async () => {
    const f = await baseFixture();
    const alpha = f.bind();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.chat.nextWrite = { kind: "delay", until: gate };
    const pending = f.core.reply(f.caller(), {
      sessionId: alpha.sessionId,
      projectId: p1,
      text: "Hello channel",
    });
    await f.emit("inbound", {
      chatThreadId: channel,
      threadRootMessageId: "inbound",
      slackUserId: slackB,
      mentionsBot: true,
    });
    release();
    const out = value(await pending);
    expect(out.conversationId).toBeDefined();
    const convs = f.rows("conversations");
    expect(convs).toHaveLength(1);
    expect(convs[0]).toMatchObject({
      conversation_id: out.conversationId,
      person_id: a.personId,
      project_id: p1,
      session_id: alpha.sessionId,
    });
    const agents = f.rows("thread_messages WHERE kind = 'agent'");
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ chat_message_id: out.chatMessageId });
  },
  timeout,
);

test(
  "OW1.reply reply refuses a conversation in a channel the project left",
  async () => {
    const f = await baseFixture({
      bells: [bellFor(b.personId, "beta")],
    });
    f.bind();
    const beta = f.bind(b);
    await f.emit("root", { slackUserId: slackB });
    const conversationId = f.read(beta.sessionId, b).items[0]!.conversationId!;
    const posted = value(
      await f.core.reply(f.caller(b), {
        sessionId: beta.sessionId,
        conversationId,
        text: "Current channel reply",
      }),
    );
    expect(posted.conversationId).toBe(conversationId);
    expect(f.writes("postText")).toHaveLength(1);
    const projects = f.config.projects.map((project) =>
      project.projectId === p1
        ? { ...project, slackChannelId: "C00000009" }
        : project,
    );
    const moved = createCoreBase(
      createCoreContext({
        ...f.deps,
        config: { ...f.config, projects },
        people: configPeople(f.config.people),
      }),
    );
    const items = f.rows("inbox_items");
    const agents = f.rows("thread_messages WHERE kind = 'agent'");
    const owed = f.rows("reply_owed");
    const writes = f.chat.writes.length;
    expect(
      refusal(
        await moved.reply(f.caller(b), {
          sessionId: beta.sessionId,
          conversationId,
          text: "Stale channel reply",
        }),
      ),
    ).toMatchObject({
      code: "INPUT_INVALID",
      pointer: "/conversationId",
      retry: "never",
    });
    expect(f.rows("inbox_items")).toEqual(items);
    expect(f.rows("thread_messages WHERE kind = 'agent'")).toEqual(agents);
    expect(f.rows("reply_owed")).toEqual(owed);
    expect(f.chat.writes).toHaveLength(writes);
  },
  timeout,
);

test(
  "OW1.reply reply refuses when the project channel is rebound during the thread wait",
  async () => {
    const f = await baseFixture();
    const alpha = f.bind();
    await f.emit("root");
    const conversationId = f.read(alpha.sessionId).items[0]!.conversationId!;
    const beforeInbox = f.rows("inbox_items");
    const beforeAgents = f.rows("thread_messages WHERE kind = 'agent'");
    const beforeOwed = f.rows("reply_owed");
    const beforeConvs = f.rows("conversations");
    const beforeWrites = f.chat.writes.length;
    const releaseGate = await enterThread(f.context, thread);
    const pending = f.core.reply(f.caller(), {
      sessionId: alpha.sessionId,
      conversationId,
      text: "Race reply",
    });
    await Bun.sleep(10);
    const rebound = f.config.projects.map((project) =>
      project.projectId === p1
        ? { ...project, slackChannelId: "C00000009" }
        : project,
    );
    createCoreBase(
      createCoreContext({
        ...f.deps,
        config: { ...f.config, projects: rebound },
        people: configPeople(f.config.people),
      }),
    );
    releaseGate();
    expect(refusal(await pending)).toEqual({
      code: "INPUT_INVALID",
      message: "The input is invalid.",
      retry: "never",
      pointer: "/conversationId",
    });
    expect(f.rows("inbox_items")).toEqual(beforeInbox);
    expect(f.rows("thread_messages WHERE kind = 'agent'")).toEqual(
      beforeAgents,
    );
    expect(f.rows("reply_owed")).toEqual(beforeOwed);
    expect(f.rows("conversations")).toEqual(beforeConvs);
    expect(f.chat.writes).toHaveLength(beforeWrites);
    createCoreBase(
      createCoreContext({
        ...f.deps,
        config: f.config,
        people: configPeople(f.config.people),
      }),
    );
    const retry = value(
      await f.core.reply(f.caller(), {
        sessionId: alpha.sessionId,
        conversationId,
        text: "After rebind",
      }),
    );
    expect(retry.conversationId).toBe(conversationId);
  },
  timeout,
);

test(
  "OW1.reply reply posts when the channel is unchanged across the thread wait",
  async () => {
    const f = await baseFixture();
    const alpha = f.bind();
    await f.emit("root");
    const conversationId = f.read(alpha.sessionId).items[0]!.conversationId!;
    const releaseGate = await enterThread(f.context, thread);
    const pending = f.core.reply(f.caller(), {
      sessionId: alpha.sessionId,
      conversationId,
      text: "Held reply",
    });
    await Bun.sleep(10);
    releaseGate();
    const out = value(await pending);
    expect(out.conversationId).toBe(conversationId);
    expect(f.writes("postText")).toHaveLength(1);
    expect(f.rows("thread_messages WHERE kind = 'agent'")).toHaveLength(1);
  },
  timeout,
);
