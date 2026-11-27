import { expect, test } from "bun:test";
import { SECRET_REMOVED_TEXT } from "../../src/contract/errors.ts";
import { LIMITS, THREAD_CONTEXT_NOTICE } from "../../src/contract/mcp.ts";
import {
  baseFixture,
  bellFor,
  channel,
  seedThread,
  thread,
  type BaseFixture,
} from "./base-fixture.ts";
import { a, b, p1, value } from "./fixture.ts";
import { slackB } from "./fakes.ts";

const timeout = 30_000;

const append = (
  f: BaseFixture,
  id: string,
  text: string,
  personId = b.personId,
) => seedThread(f, id, text, "person", personId);

async function root(f: BaseFixture) {
  const { sessionId } = f.bind();
  await f.emit("root");
  f.ack(sessionId, [f.read(sessionId).items[0]!.itemId]);
  return sessionId;
}

test(
  "TH1 channel delivery includes earlier thread context and advances the cursor",
  async () => {
    const f = await baseFixture();
    const sessionId = await root(f);
    append(f, "early", "Earlier reply");
    seedThread(f, "agent", "My question", "agent", a.personId, sessionId);
    await f.follow("current", { slackUserId: slackB, mentionsBot: false });
    const item = f.read(sessionId).items[0]!;
    expect(item).toMatchObject({ text: "current", trust: "not_your_owner" });
    expect(item.threadContext?.notice).toBe(THREAD_CONTEXT_NOTICE);
    expect(item.threadContext?.entries).toMatchObject([
      {
        text: "Earlier reply",
        senderKind: "person",
        from: b.displayName,
        notYourOwner: true,
        mentionedBot: false,
        at: new Date(f.now()).toISOString(),
      },
    ]);
    const current = "thread_messages WHERE chat_message_id = 'current'";
    const [seq] = f.col(current, "seq");
    if (typeof seq !== "number")
      throw new Error("Expected the current thread sequence");
    const { conversationId } = item;
    if (!conversationId) throw new Error("Expected a Slack conversation ID");
    expect(f.col("conversations", "context_seq")).toEqual([seq]);
    const owed = "item_id,session_id,conversation_id,answered";
    expect(f.rows("reply_owed WHERE item_id = ?", owed, item.itemId)).toEqual([
      {
        item_id: item.itemId,
        session_id: sessionId,
        conversation_id: conversationId,
        answered: 0,
      },
    ]);
  },
  timeout,
);

test(
  "TH2 context cuts the oldest whole entries at both limits",
  async () => {
    for (const [count, size, kept] of [
      [35, 100, 30],
      [20, 1_000, 8],
    ] as const) {
      const f = await baseFixture();
      const sessionId = await root(f);
      const messages = Array.from({ length: count }, (_, index) =>
        String(index).padStart(size, "x"),
      );
      for (const [index, text] of messages.entries())
        append(f, "context-" + index, text);
      await f.follow("current");
      const context = f.read(sessionId).items[0]?.threadContext;
      expect(context?.omitted).toBe(count - kept);
      expect(context?.entries.map((entry) => entry.text)).toEqual(
        messages.slice(-kept),
      );
      expect(
        context?.entries.reduce((chars, entry) => chars + entry.text.length, 0),
      ).toBeLessThanOrEqual(LIMITS.contextChars);
    }
  },
  timeout,
);

test(
  "TH5 redelivery keeps the same context range and context-only reads ring nobody new",
  async () => {
    const f = await baseFixture({ bells: [bellFor(b.personId, "beta")] });
    const alpha = await root(f);
    const beta = f.bind(b, "beta", "beta").sessionId;
    append(f, "early", "Earlier");
    await f.follow("current");
    const item = f.read(alpha).items[0]!;
    const range = () =>
      f.rows(
        "inbox_items WHERE item_id = ?",
        "context_from_seq,context_to_seq",
        item.itemId,
      );
    const before = range();
    const cursor = f.col("conversations", "context_seq");
    expect(before).toHaveLength(1);
    expect(typeof before[0]?.context_from_seq).toBe("number");
    expect(typeof before[0]?.context_to_seq).toBe("number");
    expect(f.read(alpha).items).toEqual([{ ...item, redelivered: true }]);
    expect(range()).toEqual(before);
    expect(f.col("conversations", "context_seq")).toEqual(cursor);
    await f.follow("beta-root", { slackUserId: slackB });
    const own = f.read(beta, b).items[0]!;
    f.ack(beta, [own.itemId], b);
    await f.follow("only-context-for-beta", { mentionsBot: false });
    expect(f.read(beta, b).items).toEqual([]);
    expect(
      f.col(
        "inbox_items WHERE chat_message_id = 'only-context-for-beta'",
        "owner_person_id",
      ),
    ).toEqual([a.personId]);
    expect(f.rows("doorbell_rings")).toEqual([]);
  },
  timeout,
);

test(
  "TH6 untrusted context flips the reader and parent while owner-only context does not",
  async () => {
    for (const untrusted of [true, false]) {
      const f = await baseFixture();
      const parent = f.bind(a, "parent", "not-the-front");
      const child = f.unbound({
        parentSessionId: parent.sessionId,
        projectId: p1,
      });
      await f.emit("root");
      const first = f.read(child.sessionId).items[0]!;
      f.ack(child.sessionId, [first.itemId]);
      append(
        f,
        "context",
        "Earlier reply",
        untrusted ? b.personId : a.personId,
      );
      await f.follow("current");
      const read = f.read(child.sessionId);
      expect(read.items).toMatchObject([
        {
          trust: "owner",
          threadContext: { entries: [{ notYourOwner: untrusted }] },
        },
      ]);
      const modeRows = () =>
        f.rows(
          "sessions ORDER BY rowid",
          "mode,mode_reason,untrusted_read_seq",
        );
      const mode = modeRows();
      const flipped = {
        mode: "reply_only",
        mode_reason: "read_untrusted",
        untrusted_read_seq: 1,
      };
      expect(mode).toEqual(
        untrusted
          ? [flipped, flipped]
          : [
              { mode: "normal", mode_reason: "start", untrusted_read_seq: 0 },
              {
                mode: "reply_only",
                mode_reason: "unbound_start",
                untrusted_read_seq: 0,
              },
            ],
      );
      f.expectItems(child.sessionId, [{ redelivered: true }]);
      expect(modeRows()).toEqual(mode);
    }
  },
  timeout,
);

test(
  "TH6R redelivery keeps an initially omitted member message out after an edit",
  async () => {
    const f = await baseFixture();
    const sessionId = await root(f);
    const own = ["a".repeat(3_500), "b".repeat(3_500)];
    append(f, "omitted", "x".repeat(2_000));
    for (const [index, text] of own.entries())
      append(f, "owner-" + index, text, a.personId);
    await f.follow("current");
    const first = f.read(sessionId);
    expect(first).toMatchObject({
      mode: "normal",
      items: [{ redelivered: false, threadContext: { omitted: 1 } }],
    });
    const entries = first.items[0]?.threadContext?.entries;
    expect(entries?.map((entry) => entry.text)).toEqual(own);
    const shorter = "x".repeat(500);
    await f.chat.emitMessageChange({
      channelId: channel,
      chatThreadId: thread,
      chatMessageId: "omitted",
      kind: "edited",
      text: shorter,
      fileNames: [],
    });
    expect(
      f.col("thread_messages WHERE chat_message_id = 'omitted'", "text"),
    ).toEqual([shorter]);
    const again = f.read(sessionId);
    expect(again).toMatchObject({
      mode: "normal",
      items: [{ redelivered: true }],
    });
    expect(again.items[0]?.threadContext?.entries).toEqual(entries);
    expect(f.col("sessions", "untrusted_read_seq")).toEqual([0]);
  },
  timeout,
);

test(
  "TH7 context redacts synthetic secret patterns without changing storage",
  async () => {
    const f = await baseFixture();
    const sessionId = await root(f);
    const synthetic = ["xox", "b-", "z".repeat(14)].join("");
    append(f, "secret-like", synthetic);
    await f.follow("current");
    expect(f.read(sessionId).items[0]?.threadContext?.entries).toMatchObject([
      { text: SECRET_REMOVED_TEXT },
    ]);
    expect(
      f.col("thread_messages WHERE chat_message_id = 'secret-like'", "text"),
    ).toEqual([synthetic]);
    expect(JSON.stringify(f.logged)).not.toContain(synthetic);
  },
  timeout,
);

test(
  "TH9 stored system notices do not use the context cap or count as omitted",
  async () => {
    const f = await baseFixture();
    const sessionId = await root(f);
    for (let index = 0; index < 31; index++) {
      append(f, "context-" + index, String(index));
      if (index === 12)
        seedThread(f, "queued", "Queued for Fixture Alpha's agent.", "system");
      if (index === 29)
        seedThread(
          f,
          "paused",
          "Paused: the agents need a person to reply.",
          "system",
        );
    }
    await f.follow("current");
    const context = f.read(sessionId).items[0]?.threadContext;
    expect(context?.omitted).toBe(1);
    expect(
      context?.entries.map((entry) => [entry.senderKind, entry.text]),
    ).toEqual(
      Array.from({ length: 30 }, (_, index) => ["person", String(index + 1)]),
    );
    expect(
      f.col(
        "thread_messages WHERE kind = 'system' ORDER BY seq",
        "chat_message_id",
      ),
    ).toEqual(["queued", "paused"]);
  },
  timeout,
);

test(
  "B1B-CTX1 own agent posts are excluded and cause no flip",
  async () => {
    const f = await baseFixture();
    const alpha = f.bind();
    await f.emit("root");
    const first = f.read(alpha.sessionId).items[0]!;
    f.ack(alpha.sessionId, [first.itemId]);
    const conv = first.conversationId;
    if (!conv) throw new Error("Expected a Slack conversation ID");
    value(
      await f.core.reply(f.caller(), {
        sessionId: alpha.sessionId,
        conversationId: conv,
        text: "Agent answer",
      }),
    );
    await f.follow("owner-next", { mentionsBot: false });
    const read = f.read(alpha.sessionId);
    expect(read.items).toHaveLength(1);
    expect(read.items[0]?.threadContext?.entries).toEqual([]);
    expect(read.mode).toBe("normal");
    expect(f.col("sessions", "untrusted_read_seq")).toEqual([0]);
  },
  timeout,
);

test(
  "B1B-CTX1 another agent's post is untrusted and flips once with no redelivery bump",
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
    value(
      await f.core.reply(f.caller(b), {
        sessionId: beta.sessionId,
        conversationId: betaConv,
        text: "Beta agent answer",
      }),
    );
    await f.emit("a-second", { threadRootMessageId: "root" });
    const read = f.read(alpha.sessionId);
    expect(read.items).toHaveLength(1);
    const entries = read.items[0]?.threadContext?.entries ?? [];
    expect(entries.map((entry) => entry.senderKind)).toContain("agent");
    const agent = entries.find((entry) => entry.senderKind === "agent");
    expect(agent).toMatchObject({
      from: "Fixture Beta's agent",
      notYourOwner: true,
    });
    expect(read.mode).toBe("reply_only");
    expect(
      f.col(
        "sessions WHERE session_id = ?",
        "untrusted_read_seq",
        alpha.sessionId,
      ),
    ).toEqual([1]);
    f.expectItems(alpha.sessionId, [{ redelivered: true }]);
    expect(
      f.col(
        "sessions WHERE session_id = ?",
        "untrusted_read_seq",
        alpha.sessionId,
      ),
    ).toEqual([1]);
  },
  timeout,
);
