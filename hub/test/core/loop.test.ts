import { expect, test } from "bun:test";
import { LIMITS } from "../../src/contract/mcp.ts";
import type { HubResult } from "../../src/contract/core.ts";
import { createCoreBase, createCoreContext } from "../../src/core/core.ts";
import {
  baseFixture,
  bellFor,
  seedThread,
  thread,
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
    await f.follow("mapped-bot-mention", { isBot: true, mentionsBot: true });
    await f.follow("mapped-bot-quiet", { isBot: true, mentionsBot: false });
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
    for (let index = 0; index < 9; index++) {
      if (index % 3 === 0)
        seedThread(f, "system-" + index, "system " + index, "system");
      if (index % 2 === 0) value(await reply("reply " + index));
      else value(await send("send " + index));
    }
    expect(f.posts().filter((text) => text === pause)).toHaveLength(0);
    expect(f.rows("thread_messages WHERE kind = 'agent'")).toHaveLength(9);
    value(await send("send 9"));
    expect(f.posts().filter((text) => text === pause)).toHaveLength(1);
    expect(f.rows("thread_messages WHERE kind = 'agent'")).toHaveLength(10);
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
    expect(f.rows("thread_messages WHERE kind = 'agent'")).toHaveLength(10);
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

for (const first of ["reply", "send"] as const) {
  for (const second of ["reply", "send"] as const) {
    test(
      `B1B-LOOP1 a delayed ${first} admits once while a queued ${second} pauses`,
      async () => {
        const f = await baseFixture();
        const alpha = f.bind();
        await f.emit("root");
        const conversationId = f.read(alpha.sessionId).items[0]!
          .conversationId!;
        for (let index = 0; index < 9; index++)
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
        const post = (kind: "reply" | "send", text: string) =>
          kind === "reply"
            ? f.core.reply(f.caller(), {
                sessionId: alpha.sessionId,
                conversationId,
                text,
              })
            : f.core.send(f.caller(), {
                sessionId: alpha.sessionId,
                projectId: p1,
                toPersonId: b.personId,
                conversationId,
                text,
              });
        const tenth = post(first, "tenth " + first);
        const attempts = () =>
          f.chat.calls.filter((call) => call.name === "postText").length;
        await until(() => attempts() === 1, timeout);
        const eleventh = post(second, "eleventh " + second);
        await new Promise<void>((resolve) => setImmediate(resolve));
        const racedAttempts = attempts();
        release();
        value(await tenth);
        const result = await eleventh;
        expect(racedAttempts).toBe(1);
        expect(result.ok).toBe(false);
        if (!result.ok)
          expect(result.error).toMatchObject({
            code: "CONVERSATION_PAUSED",
            retry: "never",
          });
        expect(f.posts()).toEqual([
          first === "reply"
            ? "Fixture Alpha's agent: tenth reply"
            : "Fixture Alpha's agent asked Fixture Beta's agent: tenth send",
          pause,
        ]);
        expect(f.rows("thread_messages WHERE kind = 'agent'")).toHaveLength(10);
      },
      timeout,
    );
  }
}

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
  code: "CHAT_UNAVAILABLE" as const,
  message: "Chat is unavailable.",
  retry: "reconcile_first" as const,
  repair: "Inspect that Slack thread before repeating the text.",
  conversationId,
});
const alphaPostedAs = "Forge (Fixture Alpha's agent)";

function expectUnconfirmed(id: unknown) {
  expect(String(id)).toMatch(/^unconfirmed:.{36}$/);
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

function mkSend(f: BaseFixture, sessionId: string, conversationId: string) {
  return (text: string, core: BaseFixture["core"] = f.core) =>
    core.send(f.caller(), {
      sessionId,
      projectId: p1,
      toPersonId: "per_b",
      conversationId,
      text,
    });
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

async function expectFail(
  call: Promise<HubResult<unknown>>,
  conversationId: string,
) {
  expect(refusal(await call)).toEqual(chatUnavailable(conversationId));
}

async function alphaBetaFixture() {
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
  return { f, alpha, beta, betaFirst };
}

test(
  "forge-1989 a reply post with an unknown outcome uses the loop guard slot",
  async () => {
    const { f, alpha, conversationId } = await unknownRunFixture();
    const reply = mkReply(f, alpha.sessionId, conversationId);
    f.chat.nextWrite = { kind: "unknown" };
    await expectFail(reply("tenth reply"), conversationId);
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
    expect(attempts(f)).toBe(2);
  },
  timeout,
);

test(
  "forge-1989 a visible send with an unknown outcome uses the loop guard slot",
  async () => {
    const { f, alpha, conversationId } = await unknownRunFixture();
    const send = mkSend(f, alpha.sessionId, conversationId);
    f.chat.nextWrite = { kind: "unknown" };
    const sent = value(await send("tenth send"));
    expect(sent.threadPost).toBe("failed");
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
    expect(attempts(f)).toBe(2);
  },
  timeout,
);

test(
  "forge-1989 a member post releases the pause after an unknown outcome",
  async () => {
    const { f, alpha, conversationId } = await unknownRunFixture();
    const reply = mkReply(f, alpha.sessionId, conversationId);
    f.chat.nextWrite = { kind: "unknown" };
    await expectFail(reply("tenth reply"), conversationId);
    await f.follow("member-release", {
      slackUserId: slackB,
      mentionsBot: false,
    });
    expect(value(await reply("after member"))).toEqual({
      conversationId,
      chatMessageId: "message-3",
      postedAs: alphaPostedAs,
    });
    const rows = agentRows(f);
    expect(rows).toHaveLength(LIMITS.agentRunMax + 1);
    expect(rows.map((row) => row.chat_message_id)[10]).toBe("message-3");
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
      code: "CHAT_UNAVAILABLE" as const,
      message: "Chat is unavailable.",
      retry: "safe" as const,
    });
    expect(agentRows(f).map((row) => row.chat_message_id)).toEqual(seedIds);
    expect(unconfirmedRows(f)).toEqual([]);
    expect(value(await f.core.reply(f.caller(), input))).toEqual({
      conversationId,
      chatMessageId: "message-1",
      postedAs: alphaPostedAs,
    });
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
  "forge-1989 an unconfirmed row counts for the guard and is delivered labelled",
  async () => {
    const { f, alpha, beta, betaFirst } = await alphaBetaFixture();
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
    await expectFail(reply("unconfirmed beta answer"), betaConv);
    expectPaused(await reply("eleventh beta reply"));
    await f.emit("a-second", { threadRootMessageId: "root" });
    const entries =
      f.read(alpha.sessionId).items[0]?.threadContext?.entries ?? [];
    expect(entries.map((entry) => entry.from + "|" + entry.text)).toEqual([
      "Fixture Beta|beta-mention",
      "Fixture Beta's agent (delivery unconfirmed)|" +
        "Fixture Beta's agent: unconfirmed beta answer",
    ]);
  },
  timeout,
);

test(
  "forge-1989 a failed reservation writes nothing and keeps the pre-post storage failure",
  async () => {
    const { f, alpha, conversationId } = await unknownRunFixture();
    f.db.exec(
      "CREATE TRIGGER block_reserve BEFORE INSERT ON meta WHEN NEW.key LIKE 'agent-post:%' BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END",
    );
    await expectFail(
      mkReply(f, alpha.sessionId, conversationId)("tenth reply"),
      conversationId,
    );
    await expect(
      mkSend(f, alpha.sessionId, conversationId)("tenth send"),
    ).rejects.toThrow("injected storage failure");
    expect(attempts(f)).toBe(0);
    expect(agentRows(f).map((row) => row.chat_message_id)).toEqual(seedIds);
    expect(f.rows("meta WHERE key LIKE 'agent-post:%'")).toEqual([]);
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
    await expectFail(reply("ninth reply"), conversationId);
    f.db.exec(
      "CREATE TRIGGER block_confirm BEFORE INSERT ON thread_messages WHEN NEW.chat_message_id = 'message-2' BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END",
    );
    expect(value(await reply("tenth reply"))).toEqual({
      conversationId,
      chatMessageId: "message-2",
      postedAs: alphaPostedAs,
    });
    f.db.exec("DROP TRIGGER block_confirm");
    expectPaused(await reply("eleventh reply"));
    const rows = agentRows(f);
    expect(rows.map((row) => row.chat_message_id).slice(0, -2)).toEqual(
      seedIds.slice(0, -1),
    );
    expect(rows.map((row) => row.text).slice(-2)).toEqual([
      "Fixture Alpha's agent: ninth reply",
      "Fixture Alpha's agent: tenth reply",
    ]);
    expect(unconfirmedRows(f)).toHaveLength(1);
    expect(rows.at(-1)?.chat_message_id).toBe("message-2");
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
    const { f, alpha, conversationId } = await unknownRunFixture(
      LIMITS.agentRunMax - 2,
    );
    const reply = mkReply(f, alpha.sessionId, conversationId);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.chat.nextWrite = { kind: "unknown", until: gate };
    const ninth = reply("ninth reply");
    await until(() => attempts(f) === 1, timeout);
    const gates = f.context.threadGates;
    const occupied = gates.get(thread);
    const tenth = reply("tenth reply");
    await until(() => gates.get(thread) !== occupied, timeout);
    seedThread(f, "agent-conc", "run", "agent", a.personId, alpha.sessionId);
    release();
    await expectFail(ninth, conversationId);
    expectPaused(await tenth);
    expect(attempts(f)).toBe(2);
    expect(f.posts()).toEqual(["Fixture Alpha's agent: ninth reply", pause]);
  },
  timeout,
);

test(
  "forge-1989 an unconfirmed row neither steers replies nor skips context",
  async () => {
    const { f, alpha, beta } = await alphaBetaFixture();
    seedThread(f, "ts-alpha", "alpha answer", "agent", a.personId);
    seedThread(f, UNCONFIRMED_PREFIX + "x", "beta answer", "agent", b.personId);
    await f.follow("note-one", { slackUserId: slackB, mentionsBot: false });
    const first = f.read(alpha.sessionId).items[0]!;
    expect(first.text).toBe("note-one");
    expect(f.read(beta.sessionId, b).items).toEqual([]);
    expect(
      first.threadContext?.entries.map(
        (entry) => entry.from + "|" + entry.text,
      ),
    ).toEqual([
      "Fixture Beta|beta-mention",
      "Fixture Beta's agent (delivery unconfirmed)|beta answer",
    ]);
    f.ack(alpha.sessionId, [first.itemId]);
    f.db
      .prepare(
        "UPDATE thread_messages SET chat_message_id = 'ts-confirmed' WHERE chat_message_id = ?",
      )
      .run(UNCONFIRMED_PREFIX + "x");
    seedThread(f, "ts-alpha-2", "alpha again", "agent", a.personId);
    await f.follow("note-two", { slackUserId: slackB, mentionsBot: false });
    expect(f.read(alpha.sessionId).items[0]!.threadContext?.entries).toEqual(
      [],
    );
  },
  timeout,
);

function holdAgentPost(
  f: BaseFixture,
  outcome: "confirmed" | "unknown" | "refused",
) {
  const enter = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const post = f.chat.postText.bind(f.chat);
  f.chat.postText = async (...args) => {
    f.chat.postText = post;
    enter.resolve();
    await release.promise;
    if (outcome !== "confirmed") f.chat.nextWrite = { kind: outcome };
    return post(...args);
  };
  return { entered: enter.promise, release: release.resolve };
}

for (const kind of ["reply", "send"] as const) {
  for (const outcome of ["confirmed", "unknown"] as const) {
    test(
      `a post settled after a concurrent member starts the new run (${kind}, ${outcome})`,
      async () => {
        const { f, alpha, conversationId } = await unknownRunFixture();
        const post = (kind === "reply" ? mkReply : mkSend)(
          f,
          alpha.sessionId,
          conversationId,
        );
        const held = holdAgentPost(f, outcome);
        const tenth = post("in flight");
        await held.entered;
        await f.follow("member during write");
        held.release();
        await tenth;
        const member = f.rows(
          "thread_messages WHERE chat_message_id = 'member during write'",
        )[0]!;
        expect(Number(agentRows(f).at(-1)?.seq)).toBeGreaterThan(
          Number(member.seq),
        );
        for (const id of seedIds) value<unknown>(await post("new " + id));
        expectPaused(await post("over limit"));
        expect(f.posts().filter((text) => text !== pause)).toHaveLength(
          LIMITS.agentRunMax,
        );
      },
      timeout,
    );
  }
}

for (const outcome of ["confirmed", "unknown"] as const) {
  test(
    `settlement never redelivers transcript context (${outcome})`,
    async () => {
      const { f, alpha, beta, betaFirst } = await alphaBetaFixture();
      const held = holdAgentPost(f, outcome);
      const attempt = f.core.reply(f.caller(b), {
        sessionId: beta.sessionId,
        conversationId: betaFirst.conversationId!,
        text: "held context",
      });
      const read = async (id: string) => {
        await f.follow(id);
        const item = f.read(alpha.sessionId).items[0]!;
        f.ack(alpha.sessionId, [item.itemId]);
        return item.threadContext!.entries.map((entry) => entry.text);
      };
      await held.entered;
      const during = await read("during");
      held.release();
      await attempt;
      const settled = agentRows(f);
      const later = [...(await read("later")), ...(await read("last"))];
      expect(during).not.toContain("Fixture Beta's agent: held context");
      expect(later.filter((text) => text.endsWith("held context"))).toEqual([
        "Fixture Beta's agent: held context",
      ]);
      expect(agentRows(f)).toEqual(settled);
    },
    timeout,
  );
}

for (const first of ["reply", "send"] as const) {
  for (const second of ["reply", "send"] as const) {
    for (const outcome of ["confirmed", "unknown", "refused"] as const) {
      test(
        `a queued caller ${outcome === "refused" ? "proceeds when the pending tenth attempt is refused" : "refuses after a delivered or unknown tenth attempt"} (${first}, ${second}, ${outcome})`,
        async () => {
          const { f, alpha, conversationId } = await unknownRunFixture();
          const post = {
            reply: mkReply(f, alpha.sessionId, conversationId),
            send: mkSend(f, alpha.sessionId, conversationId),
          };
          const held = holdAgentPost(f, outcome);
          const tenth = post[first]("pending tenth");
          await held.entered;
          const occupied = f.context.threadGates.get(thread);
          const next = post[second]("queued text");
          const queued = f.context.threadGates.get(thread);
          const agentTexts = () =>
            f.chat.calls
              .filter(
                (call) =>
                  call.name === "postText" &&
                  (call.args[1] !== pause || call.args[2] !== undefined),
              )
              .map((call) => [call.args[1], call.args[2]]);
          await new Promise<void>((resolve) => setImmediate(resolve));
          const whileHeld = agentTexts();
          held.release();
          await tenth;
          const result = await next;
          expect(occupied).toBeDefined();
          expect(queued).toBeDefined();
          expect(queued).not.toBe(occupied);
          expect(whileHeld).toEqual([]);
          if (outcome === "refused") expect(result.ok).toBe(true);
          else expectPaused(result);
          const agentText = (kind: "reply" | "send", text: string) =>
            (kind === "reply"
              ? "Fixture Alpha's agent: "
              : "Fixture Alpha's agent asked Fixture Beta's agent: ") + text;
          const call = (kind: "reply" | "send", text: string) => [
            agentText(kind, text),
            { agentLabel: alphaPostedAs },
          ];
          const expected = [call(first, "pending tenth")];
          if (outcome === "refused") expected.push(call(second, "queued text"));
          expect(agentTexts()).toEqual(expected);
          expect(agentRows(f)).toHaveLength(LIMITS.agentRunMax);
        },
        timeout,
      );
    }
  }
}

test(
  "the original inbound member message survives a failed confirmed-post projection",
  async () => {
    const { f, alpha, beta, betaFirst } = await alphaBetaFixture();
    seedRun(f, LIMITS.agentRunMax - 1, alpha.sessionId);
    f.db.exec(
      "CREATE TRIGGER block_agent BEFORE INSERT ON thread_messages WHEN NEW.kind = 'agent' BEGIN SELECT RAISE(ABORT, 'injected projection failure'); END",
    );
    const posted = value(
      await f.core.reply(f.caller(b), {
        sessionId: beta.sessionId,
        conversationId: betaFirst.conversationId!,
        text: "beta answer",
      }),
    );
    const reply = mkReply(
      f,
      alpha.sessionId,
      f.col(
        "conversations WHERE person_id = 'per_a'",
        "conversation_id",
      )[0] as string,
    );
    for (const text of ["first retry", "second retry"])
      expect(refusal(await reply(text))).toMatchObject({
        code: "CHAT_UNAVAILABLE",
        retry: "reconcile_first",
      });
    const inbound = () => f.follow("beta follow-up", { mentionsBot: false });
    await inbound();
    const items = () =>
      f
        .read(beta.sessionId, b)
        .items.map(({ itemId, text }) => ({ itemId, text }));
    const delivered = items();
    expect(delivered.map(({ text }) => text)).toEqual(["beta follow-up"]);
    expect(f.read(alpha.sessionId).items).toEqual([]);
    const members = () =>
      f.rows(
        "thread_messages WHERE chat_message_id = 'beta follow-up' AND kind = 'person'",
      );
    expect(members()).toHaveLength(1);
    expect(f.rows("meta WHERE key LIKE 'agent-post:%'")).toHaveLength(1);
    expect(attempts(f)).toBe(1);
    f.db.exec("DROP TRIGGER block_agent");
    await inbound();
    expect(items()).toEqual(delivered);
    expect(members()).toHaveLength(1);
    expect(agentRows(f).at(-1)?.chat_message_id).toBe(posted.chatMessageId);
    expect(f.rows("meta WHERE key LIKE 'agent-post:%'")).toEqual([]);
    expect(attempts(f)).toBe(1);
  },
  timeout,
);

test(
  "an outsider triggers one pause notice after the recovered tenth post",
  async () => {
    const { f, alpha, conversationId } = await unknownRunFixture();
    f.db.exec(
      "CREATE TRIGGER block_agent BEFORE INSERT ON thread_messages WHEN NEW.kind = 'agent' BEGIN SELECT RAISE(ABORT, 'injected projection failure'); END",
    );
    const reply = mkReply(f, alpha.sessionId, conversationId);
    const { chatMessageId } = value(await reply("tenth"));
    expect(f.posts()).toEqual(["Fixture Alpha's agent: tenth"]);
    f.db.exec("DROP TRIGGER block_agent");
    const outsider = () =>
      f.follow("outsider recovery", {
        slackUserId: unknownUser,
        mentionsBot: false,
      });
    const post = f.chat.postText.bind(f.chat);
    f.chat.postText = (...args) => {
      if (args[1] === pause)
        expect(
          f.rows(
            "thread_messages WHERE chat_message_id = 'outsider recovery' AND kind = 'outsider'",
          ),
        ).toHaveLength(1);
      return post(...args);
    };
    await outsider();
    expect(f.posts()).toEqual(["Fixture Alpha's agent: tenth", pause]);
    expect(agentRows(f).at(-1)?.chat_message_id).toBe(chatMessageId);
    await outsider();
    expectPaused(await reply("eleventh"));
    expect(f.posts()).toEqual(["Fixture Alpha's agent: tenth", pause]);
  },
  timeout,
);

test(
  "a confirmed reply clears its owed rows before awaiting the pause notice",
  async () => {
    const { f, alpha, conversationId } = await unknownRunFixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const post = f.chat.postText.bind(f.chat);
    f.chat.postText = async (...args) => {
      if (args[1] === pause) {
        entered.resolve();
        await release.promise;
      }
      return post(...args);
    };
    const result = mkReply(f, alpha.sessionId, conversationId)("tenth");
    await entered.promise;
    const owed = f.col("reply_owed", "answered");
    release.resolve();
    value(await result);
    expect(owed).toEqual([1]);
  },
  timeout,
);

test(
  "a failed refusal cleanup is recovered before the next pause check",
  async () => {
    const { f, alpha, conversationId } = await unknownRunFixture();
    const reply = mkReply(f, alpha.sessionId, conversationId);
    f.db.exec(
      "CREATE TRIGGER block_cleanup BEFORE DELETE ON meta WHEN OLD.key LIKE 'agent-post:%' BEGIN SELECT RAISE(ABORT, 'injected cleanup failure'); END",
    );
    f.chat.nextWrite = { kind: "refused" };
    expect(refusal(await reply("refused tenth")).retry).toBe("safe");
    expect(f.rows("meta WHERE key LIKE 'agent-post:%'")).toHaveLength(1);
    await expectFail(reply("blocked by storage"), conversationId);
    expect(attempts(f)).toBe(1);
    f.db.exec("DROP TRIGGER block_cleanup");
    value(await reply("replacement tenth"));
    expectPaused(await reply("extra"));
    expect(agentRows(f)).toHaveLength(LIMITS.agentRunMax);
    expect(unconfirmedRows(f)).toEqual([]);
  },
  timeout,
);

for (const kind of ["reply", "send"] as const) {
  for (const failNotice of [false, true]) {
    test(
      `${failNotice ? "a failed pause notice preserves the original post result and a later paused caller retries a missing notice once" : "an unknown tenth reply or send posts one pause notice"} (${kind})`,
      async () => {
        const { f, alpha, conversationId } = await unknownRunFixture();
        const post = (kind === "reply" ? mkReply : mkSend)(
          f,
          alpha.sessionId,
          conversationId,
        );
        const transport = f.chat.postText.bind(f.chat);
        f.chat.postText = (target, text, options) => {
          if (text !== pause) f.chat.nextWrite = { kind: "unknown" };
          else if (failNotice && attempts(f) === 1)
            f.chat.nextWrite = { kind: "refused" };
          return transport(target, text, options);
        };
        if (kind === "reply")
          await expectFail(post("unknown tenth"), conversationId);
        else
          expect(await post("unknown tenth")).toMatchObject({
            ok: true,
            value: { threadPost: "failed" },
          });
        expect(attempts(f)).toBe(2);
        expect(f.posts().filter((text) => text === pause)).toHaveLength(
          failNotice ? 0 : 1,
        );
        expectPaused(await post("retry notice"));
        expectPaused(await post("notice already recorded"));
        expect(attempts(f)).toBe(failNotice ? 3 : 2);
        expect(unconfirmedRows(f)).toHaveLength(1);
        expect(
          f.rows(
            "thread_messages WHERE kind = 'system' AND text = ?",
            "*",
            pause,
          ),
        ).toHaveLength(1);
        expect(f.posts().filter((text) => text !== pause)).toHaveLength(1);
      },
      timeout,
    );
  }
}
