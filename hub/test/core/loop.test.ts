import { expect, test } from "bun:test";
import { LIMITS } from "../../src/contract/mcp.ts";
import { baseFixture, seedThread, unknownUser } from "./base-fixture.ts";
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
  "LP3 a member post over the mention limit is recorded so the pause releases without delivery",
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
    for (let index = 0; index < LIMITS.agentRunMax; index++)
      value(await reply("reply " + index));
    expect(refusal(await reply("blocked reply"))).toMatchObject({
      code: "CONVERSATION_PAUSED",
      retry: "never",
    });
    const itemsBefore = f.rows("inbox_items", "item_id");
    const reactsBefore = f.writes("react").length;
    const targets = ["U00000002", "U00000003", "U00000004", "U00000005"];
    expect(targets).toHaveLength(LIMITS.mentionTargetsMax + 1);
    await f.follow("member-overlimit", { mentionedSlackUserIds: targets });
    const note = "Name at most " + LIMITS.mentionTargetsMax + " people.";
    expect(f.posts()).toContain(note);
    expect(
      f.rows(
        "thread_messages WHERE chat_message_id = 'member-overlimit'",
        "kind,person_id,text",
      ),
    ).toEqual([
      { kind: "person", person_id: a.personId, text: "member-overlimit" },
    ]);
    expect(f.rows("inbox_items", "item_id")).toEqual(itemsBefore);
    expect(f.writes("react")).toHaveLength(reactsBefore);
    value(await reply("after a person"));
    const postCount = f.posts().length;
    await f.follow("member-overlimit", { mentionedSlackUserIds: targets });
    expect(
      f.rows("thread_messages WHERE chat_message_id = 'member-overlimit'"),
    ).toHaveLength(1);
    expect(f.posts()).toHaveLength(postCount);
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
