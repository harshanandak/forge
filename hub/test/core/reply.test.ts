import { expect, test } from "bun:test";
import { SUMMARY_KEY_MARKER } from "../../src/contract/chat.ts";
import type { HubErrorCode } from "../../src/contract/errors.ts";
import { LIMITS, type ReplyInput } from "../../src/contract/mcp.ts";
import { createCoreBase, createCoreContext } from "../../src/core/core.ts";
import { baseFixture, bellFor, seedThread, thread } from "./base-fixture.ts";
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
