import { expect, test } from "bun:test";
import { SUMMARY_KEY_MARKER } from "../../src/contract/chat.ts";
import type { HubErrorCode } from "../../src/contract/errors.ts";
import { LIMITS } from "../../src/contract/mcp.ts";
import { createCoreBase, createCoreContext } from "../../src/core/core.ts";
import { baseFixture, seedThread } from "./base-fixture.ts";
import { refusal } from "./base-fakes.ts";
import { a, b, configPeople, p1, value } from "./fixture.ts";
import { slackB } from "./fakes.ts";

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
