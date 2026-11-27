import { expect, test } from "bun:test";
import { LIMITS } from "../../src/contract/mcp.ts";
import type { HubResult } from "../../src/contract/core.ts";
import { createCoreBase, createCoreContext } from "../../src/core/core.ts";
import {
  baseFixture,
  bellFor,
  seedThread,
  unknownUser,
  type BaseFixture,
} from "./base-fixture.ts";
import { refusal, until } from "./base-fakes.ts";
import { a, b, p1, value } from "./fixture.ts";
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
  f.rows("thread_messages WHERE kind = 'agent' ORDER BY seq");
const UNCONFIRMED_PREFIX = "unconfirmed:";
const unconfirmedRows = (f: BaseFixture) =>
  agentRows(f).filter((row) =>
    String(row.chat_message_id).startsWith(UNCONFIRMED_PREFIX),
  );
const seedIds = Array.from(
  { length: LIMITS.agentRunMax - 1 },
  (_, index) => "agent-" + index,
);
const chatUnavailable = (conversationId: string) => ({
  code: "CHAT_UNAVAILABLE",
  message: "Chat is unavailable.",
  retry: "reconcile_first",
  repair: "Inspect that Slack thread before repeating the text.",
  conversationId,
});
const alphaPostedAs = "Forge (Fixture Alpha's agent)";

function expectUnconfirmed(id: unknown) {
  const text = String(id);
  expect(text.startsWith(UNCONFIRMED_PREFIX)).toBe(true);
  expect(text).toHaveLength(UNCONFIRMED_PREFIX.length + 36);
}

function seedRun(f: BaseFixture, count: number, sessionId: string) {
  for (let index = 0; index < count; index++)
    seedThread(f, "agent-" + index, "run", "agent", a.personId, sessionId);
}

async function unknownRunFixture(seeds = LIMITS.agentRunMax - 1) {
  const f = await baseFixture();
  const alpha = f.bind();
  await f.emit("root");
  const conversationId = f.read(alpha.sessionId).items[0]!.conversationId!;
  seedRun(f, seeds, alpha.sessionId);
  return { f, alpha, conversationId };
}

function mkReply(f: BaseFixture, sessionId: string, conversationId: string) {
  return (text: string, core: BaseFixture["core"] = f.core) =>
    core.reply(f.caller(), { sessionId, conversationId, text });
}

function expectPaused(result: HubResult<unknown>) {
  expect(result).toEqual({
    ok: false,
    error: {
      code: "CONVERSATION_PAUSED",
      message: "The conversation is paused.",
      retry: "never",
    },
  });
}

test(
  "forge-1989 a reply post with an unknown outcome uses the loop guard slot",
  async () => {
    const { f, alpha, conversationId } = await unknownRunFixture();
    const reply = mkReply(f, alpha.sessionId, conversationId);
    f.chat.nextWrite = { kind: "unknown" };
    expect(refusal(await reply("tenth reply"))).toEqual(
      chatUnavailable(conversationId),
    );
    expect(attempts(f)).toBe(1);
    const rows = agentRows(f);
    expect(
      rows.map((row) => [row.text, row.person_id, row.session_id]),
    ).toEqual([
      ...seedIds.map(() => ["run", a.personId, alpha.sessionId]),
      ["Fixture Alpha's agent: tenth reply", a.personId, alpha.sessionId],
    ]);
    const ids = rows.map((row) => row.chat_message_id);
    expect(ids.slice(0, -1)).toEqual(seedIds);
    expectUnconfirmed(ids[9]);
    expectPaused(await reply("eleventh reply"));
    const restarted = createCoreBase(createCoreContext(f.deps));
    expectPaused(await reply("rebuilt eleventh reply", restarted));
    expect(attempts(f)).toBe(1);
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
    const sent = value(await send("tenth send"));
    expect(sent.threadPost).toBe("failed");
    expect(attempts(f)).toBe(1);
    const rows = agentRows(f);
    expect(rows.map((row) => row.text)).toEqual([
      ...seedIds.map(() => "run"),
      "Fixture Alpha's agent asked Fixture Beta's agent: tenth send",
    ]);
    const ids = rows.map((row) => row.chat_message_id);
    expect(ids.slice(0, -1)).toEqual(seedIds);
    expectUnconfirmed(ids[9]);
    expectPaused(await send("eleventh send"));
    const restarted = createCoreBase(createCoreContext(f.deps));
    expectPaused(await send("rebuilt eleventh send", restarted));
    expect(attempts(f)).toBe(1);
  },
  timeout,
);

test(
  "forge-1989 a member post releases the pause after an unknown outcome",
  async () => {
    const { f, alpha, conversationId } = await unknownRunFixture();
    const reply = mkReply(f, alpha.sessionId, conversationId);
    f.chat.nextWrite = { kind: "unknown" };
    expect(refusal(await reply("tenth reply"))).toEqual(
      chatUnavailable(conversationId),
    );
    await f.follow("member-release", {
      slackUserId: slackB,
      mentionsBot: false,
    });
    expect(value(await reply("after member"))).toEqual({
      conversationId,
      chatMessageId: "message-2",
      postedAs: alphaPostedAs,
    });
    expect(attempts(f)).toBe(2);
    const rows = agentRows(f);
    expect(rows).toHaveLength(LIMITS.agentRunMax + 1);
    expect(rows.map((row) => row.chat_message_id)[10]).toBe("message-2");
    expect(unconfirmedRows(f)).toHaveLength(1);
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
    expect(agentRows(f).map((row) => row.chat_message_id)).toEqual(seedIds);
    expect(unconfirmedRows(f)).toEqual([]);
    expect(value(await f.core.reply(f.caller(), input))).toEqual({
      conversationId,
      chatMessageId: "message-1",
      postedAs: alphaPostedAs,
    });
    expect(attempts(f)).toBe(3);
    expect(f.posts()).toEqual([
      "Fixture Alpha's agent: refused tenth reply",
      pause,
    ]);
    expect(agentRows(f).map((row) => row.chat_message_id)).toEqual([
      ...seedIds,
      "message-1",
    ]);
    expect(unconfirmedRows(f)).toEqual([]);
  },
  timeout,
);

test(
  "forge-1989 an unconfirmed row counts for the guard but stays out of delivered context",
  async () => {
    const f = await baseFixture({ bells: [bellFor(b.personId, "beta")] });
    const alpha = f.bind();
    const beta = f.bind(b, "beta", "beta");
    await f.emit("root");
    await f.emit("beta-mention", {
      slackUserId: slackB,
      threadRootMessageId: "root",
    });
    const alphaFirst = f.read(alpha.sessionId).items[0]!;
    f.ack(alpha.sessionId, [alphaFirst.itemId]);
    const betaFirst = f.read(beta.sessionId, b).items[0]!;
    f.ack(beta.sessionId, [betaFirst.itemId], b);
    const betaConv = betaFirst.conversationId;
    if (!betaConv) throw new Error("Expected a Slack conversation ID");
    seedRun(f, LIMITS.agentRunMax - 1, alpha.sessionId);
    const reply = (text: string) =>
      f.core.reply(f.caller(b), {
        sessionId: beta.sessionId,
        conversationId: betaConv,
        text,
      });
    f.chat.nextWrite = { kind: "unknown" };
    expect(refusal(await reply("unconfirmed beta answer"))).toEqual(
      chatUnavailable(betaConv),
    );
    expectPaused(await reply("eleventh beta reply"));
    await f.emit("a-second", { threadRootMessageId: "root" });
    const read = f.read(alpha.sessionId);
    expect(read.items).toHaveLength(1);
    const entries = read.items[0]?.threadContext?.entries ?? [];
    expect(entries.map((entry) => entry.text)).toEqual(["beta-mention"]);
  },
  timeout,
);

test(
  "forge-1989 a failed reservation writes nothing and keeps the pre-post storage failure",
  async () => {
    const { f, alpha, conversationId } = await unknownRunFixture();
    f.db.exec(
      "CREATE TRIGGER block_reserve BEFORE INSERT ON thread_messages WHEN NEW.chat_message_id LIKE 'unconfirmed:%' BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END",
    );
    expect(
      refusal(await mkReply(f, alpha.sessionId, conversationId)("tenth reply")),
    ).toEqual(chatUnavailable(conversationId));
    await expect(
      f.core.send(f.caller(), {
        sessionId: alpha.sessionId,
        projectId: p1,
        toPersonId: "per_b",
        conversationId,
        text: "tenth send",
      }),
    ).rejects.toThrow("injected storage failure");
    expect(attempts(f)).toBe(0);
    expect(agentRows(f).map((row) => row.chat_message_id)).toEqual(seedIds);
  },
  timeout,
);

test(
  "forge-1989 an unknown outcome and a failed confirm both keep their slots",
  async () => {
    const { f, alpha, conversationId } = await unknownRunFixture(
      LIMITS.agentRunMax - 2,
    );
    const reply = mkReply(f, alpha.sessionId, conversationId);
    f.chat.nextWrite = { kind: "unknown" };
    expect(refusal(await reply("ninth reply"))).toEqual(
      chatUnavailable(conversationId),
    );
    f.db.exec(
      "CREATE TRIGGER block_confirm BEFORE UPDATE ON thread_messages BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END",
    );
    expect(value(await reply("tenth reply"))).toEqual({
      conversationId,
      chatMessageId: "message-2",
      postedAs: alphaPostedAs,
    });
    const rows = agentRows(f);
    expect(rows).toHaveLength(LIMITS.agentRunMax);
    expect(rows.map((row) => row.chat_message_id).slice(0, -2)).toEqual(
      seedIds.slice(0, -1),
    );
    expect(rows.map((row) => row.text).slice(-2)).toEqual([
      "Fixture Alpha's agent: ninth reply",
      "Fixture Alpha's agent: tenth reply",
    ]);
    expect(unconfirmedRows(f)).toHaveLength(2);
    expectPaused(await reply("eleventh reply"));
    expect(attempts(f)).toBe(3);
    expect(f.posts()).toEqual([
      "Fixture Alpha's agent: ninth reply",
      "Fixture Alpha's agent: tenth reply",
      pause,
    ]);
  },
  timeout,
);

test(
  "forge-1989 a queued caller sees the slot an unknown-outcome write consumed",
  async () => {
    const { f, alpha, conversationId } = await unknownRunFixture();
    const reply = mkReply(f, alpha.sessionId, conversationId);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.chat.nextWrite = { kind: "unknown", until: gate };
    const tenth = reply("tenth reply");
    await until(() => attempts(f) === 1, timeout);
    const eleventh = reply("eleventh reply");
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    expect(refusal(await tenth)).toEqual(chatUnavailable(conversationId));
    expectPaused(await eleventh);
    expect(attempts(f)).toBe(1);
    expect(f.posts()).toEqual(["Fixture Alpha's agent: tenth reply"]);
    const ids = agentRows(f).map((row) => row.chat_message_id);
    expect(ids.slice(0, -1)).toEqual(seedIds);
    expectUnconfirmed(ids[9]);
  },
  timeout,
);
