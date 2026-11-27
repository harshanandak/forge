import { expect, test } from "bun:test";
import { LIMITS } from "../../src/contract/mcp.ts";
import type { HubResult } from "../../src/contract/core.ts";
import { createCoreBase, createCoreContext } from "../../src/core/core.ts";
import {
  baseFixture,
  seedThread,
  unknownUser,
  type BaseFixture,
} from "./base-fixture.ts";
import { refusal, until } from "./base-fakes.ts";
import { a, p1, value } from "./fixture.ts";
import { slackB } from "./fakes.ts";

const timeout = 30_000;
const pause = "Paused: the agents need a person to reply.";

test(
  "LP1 even a bot mapped to a person creates no thread row or item",
  async () => {
    const f = await baseFixture();
    f.bind();
    await f.emit("root");
    await f.follow("mapped-bot", { isBot: true });
    for (const table of ["inbox_items", "thread_messages"])
      expect(f.sql("SELECT chat_message_id FROM " + table)).toEqual([
        { chat_message_id: "root" },
      ]);
  },
  timeout,
);

test(
  "LP2 ten agent posts pause once until a project member posts",
  async () => {
    const f = await baseFixture();
    const alpha = f.bind();
    await f.emit("root");
    const conversationId = f.read(alpha.sessionId).items[0]!.conversationId!;
    const reply = (text: string) =>
      f.core.reply(f.caller(), {
        sessionId: alpha.sessionId,
        conversationId,
        text,
      });
    const send = (text: string) =>
      f.core.send(f.caller(), {
        sessionId: alpha.sessionId,
        projectId: p1,
        toPersonId: "per_b",
        conversationId,
        text,
      });
    for (let index = 0; index < LIMITS.agentRunMax; index++) {
      if (index % 3 === 0)
        seedThread(f, "system-" + index, "system " + index, "system");
      if (index % 2 === 0) value(await reply("reply " + index));
      else value(await send("send " + index));
    }
    expect(f.posts().filter((text) => text === pause)).toHaveLength(1);
    expect(f.rows("thread_messages WHERE kind = 'agent'")).toHaveLength(
      LIMITS.agentRunMax,
    );
    const pauseRows = () =>
      f.sql(
        "SELECT seq FROM thread_messages WHERE kind = 'system' AND text = ?",
        pause,
      );
    expect(pauseRows()).toHaveLength(1);
    await f.follow("outsider", {
      slackUserId: unknownUser,
      mentionsBot: false,
    });
    const attempts = () =>
      f.chat.calls.filter((call) => call.name === "postText").length;
    const before = attempts();
    expect(refusal(await reply("blocked reply"))).toMatchObject({
      code: "CONVERSATION_PAUSED",
      retry: "never",
    });
    expect(refusal(await send("blocked send"))).toMatchObject({
      code: "CONVERSATION_PAUSED",
      retry: "never",
    });
    expect(attempts()).toBe(before);
    expect(pauseRows()).toHaveLength(1);
    await f.follow("member-release", {
      slackUserId: slackB,
      mentionsBot: false,
    });
    value(await reply("after a person"));
    expect(pauseRows()).toHaveLength(1);
  },
  timeout,
);

test(
  "B1B-LOOP1 a concurrent reply is rechecked inside the thread gate",
  async () => {
    const f = await baseFixture();
    const alpha = f.bind();
    await f.emit("root");
    const conversationId = f.read(alpha.sessionId).items[0]!.conversationId!;
    for (let index = 0; index < LIMITS.agentRunMax - 1; index++)
      seedThread(
        f,
        "agent-" + index,
        "run",
        "agent",
        a.personId,
        alpha.sessionId,
      );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.chat.nextWrite = { kind: "delay", until: gate };
    const reply = (text: string) =>
      f.core.reply(f.caller(), {
        sessionId: alpha.sessionId,
        conversationId,
        text,
      });
    const tenth = reply("tenth");
    const attempts = () =>
      f.chat.calls.filter((call) => call.name === "postText").length;
    await until(() => attempts() === 1, timeout);
    const eleventh = reply("eleventh");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const racedAttempts = attempts();
    release();
    value(await tenth);
    const second = await eleventh;
    expect(racedAttempts).toBe(1);
    expect(second.ok).toBe(false);
    if (!second.ok)
      expect(second.error).toMatchObject({
        code: "CONVERSATION_PAUSED",
        retry: "never",
      });
    expect(f.posts()).toEqual(["Fixture Alpha's agent: tenth", pause]);
    expect(f.rows("thread_messages WHERE kind = 'agent'")).toHaveLength(
      LIMITS.agentRunMax,
    );
  },
  timeout,
);

const attempts = (f: BaseFixture) =>
  f.chat.calls.filter((call) => call.name === "postText").length;
const agentRows = (f: BaseFixture) =>
  f.rows("thread_messages WHERE kind = 'agent'");

async function unknownRunFixture() {
  const f = await baseFixture();
  const alpha = f.bind();
  await f.emit("root");
  const conversationId = f.read(alpha.sessionId).items[0]!.conversationId!;
  for (let index = 0; index < LIMITS.agentRunMax - 1; index++)
    seedThread(
      f,
      "agent-" + index,
      "run",
      "agent",
      a.personId,
      alpha.sessionId,
    );
  return { f, alpha, conversationId };
}

function expectPaused(result: HubResult<unknown>) {
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.error).toMatchObject({
      code: "CONVERSATION_PAUSED",
      retry: "never",
    });
}

test(
  "forge-1989 a reply post with an unknown outcome uses the loop guard slot",
  async () => {
    const { f, alpha, conversationId } = await unknownRunFixture();
    const reply = (text: string, core: BaseFixture["core"] = f.core) =>
      core.reply(f.caller(), {
        sessionId: alpha.sessionId,
        conversationId,
        text,
      });
    f.chat.nextWrite = { kind: "unknown" };
    const error = refusal(await reply("tenth reply"));
    expect(error).toMatchObject({
      code: "CHAT_UNAVAILABLE",
      retry: "reconcile_first",
      repair: "Inspect that Slack thread before repeating the text.",
      conversationId,
    });
    expect(attempts(f)).toBe(1);
    expect(agentRows(f)).toHaveLength(LIMITS.agentRunMax);
    expect(
      f.col(
        "thread_messages WHERE kind = 'agent' ORDER BY seq DESC",
        "chat_message_id",
      )[0],
    ).toMatch(/^unconfirmed:/);
    const before = attempts(f);
    expectPaused(await reply("eleventh reply"));
    const restarted = createCoreBase(createCoreContext(f.deps));
    expectPaused(await reply("rebuilt eleventh reply", restarted));
    expect(attempts(f)).toBe(before);
  },
  timeout,
);

test(
  "forge-1989 a visible send with an unknown outcome uses the loop guard slot",
  async () => {
    const { f, alpha, conversationId } = await unknownRunFixture();
    const send = (text: string, core: BaseFixture["core"] = f.core) =>
      core.send(f.caller(), {
        sessionId: alpha.sessionId,
        projectId: p1,
        toPersonId: "per_b",
        conversationId,
        text,
      });
    f.chat.nextWrite = { kind: "unknown" };
    expect(value(await send("tenth send")).threadPost).toBe("failed");
    expect(attempts(f)).toBe(1);
    expect(agentRows(f)).toHaveLength(LIMITS.agentRunMax);
    expect(
      f.col(
        "thread_messages WHERE kind = 'agent' ORDER BY seq DESC",
        "chat_message_id",
      )[0],
    ).toMatch(/^unconfirmed:/);
    const before = attempts(f);
    expectPaused(await send("eleventh send"));
    const restarted = createCoreBase(createCoreContext(f.deps));
    expectPaused(await send("rebuilt eleventh send", restarted));
    expect(attempts(f)).toBe(before);
  },
  timeout,
);

test(
  "forge-1989 a member post releases the pause after an unknown outcome",
  async () => {
    const { f, alpha, conversationId } = await unknownRunFixture();
    f.chat.nextWrite = { kind: "unknown" };
    refusal(
      await f.core.reply(f.caller(), {
        sessionId: alpha.sessionId,
        conversationId,
        text: "tenth reply",
      }),
    );
    expect(agentRows(f)).toHaveLength(LIMITS.agentRunMax);
    await f.follow("member-release", {
      slackUserId: slackB,
      mentionsBot: false,
    });
    const before = attempts(f);
    const posted = value(
      await f.core.reply(f.caller(), {
        sessionId: alpha.sessionId,
        conversationId,
        text: "after member",
      }),
    );
    expect(posted.conversationId).toBe(conversationId);
    expect(attempts(f)).toBe(before + 1);
    expect(agentRows(f)).toHaveLength(LIMITS.agentRunMax + 1);
  },
  timeout,
);

test(
  "forge-1989 a refused reply records nothing and remains safe to retry",
  async () => {
    const { f, alpha, conversationId } = await unknownRunFixture();
    const input = {
      sessionId: alpha.sessionId,
      conversationId,
      text: "refused tenth reply",
    };
    f.chat.nextWrite = { kind: "refused", reason: "not_in_channel" };
    expect(refusal(await f.core.reply(f.caller(), input))).toEqual({
      code: "CHAT_UNAVAILABLE",
      message: "Chat is unavailable.",
      retry: "safe",
    });
    expect(agentRows(f)).toHaveLength(LIMITS.agentRunMax - 1);
    expect(
      f.rows("thread_messages WHERE chat_message_id LIKE 'unconfirmed:%'"),
    ).toEqual([]);
    expect(value(await f.core.reply(f.caller(), input)).conversationId).toBe(
      conversationId,
    );
    expect(attempts(f)).toBe(3);
    expect(f.posts()).toEqual([
      "Fixture Alpha's agent: refused tenth reply",
      pause,
    ]);
    expect(agentRows(f)).toHaveLength(LIMITS.agentRunMax);
  },
  timeout,
);
