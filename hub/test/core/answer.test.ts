import { expect, test } from "bun:test";
import { LIMITS, LONG_ANSWER_SEPARATOR } from "../../src/contract/mcp.ts";
import { createCoreBase, createCoreContext } from "../../src/core/core.ts";
import { baseFixture, channel } from "./base-fixture.ts";
import { p1, value } from "./fixture.ts";
import { FakeChatPort } from "../fakes/fake-chat.ts";

const timeout = 30_000;
const prefix = "Fixture Alpha's agent:";

const setup = async () => {
  const f = await baseFixture();
  const alpha = f.bind();
  await f.emit("root");
  const first = f.read(alpha.sessionId).items[0]!;
  f.ack(alpha.sessionId, [first.itemId]);
  const conv = first.conversationId;
  if (!conv) throw new Error("Expected a Slack conversation ID");
  return { f, alpha, conv };
};

const shortOf = (post: unknown) =>
  String(post)
    .slice(prefix.length + 1)
    .split("\nFull answer: ")[0]!;

test(
  "SA1 separator posts the short part with a canvas link and no separator",
  async () => {
    const { f, alpha, conv } = await setup();
    const text =
      "Short summary\n" + LONG_ANSWER_SEPARATOR + "\nThe full detail.";
    value(
      await f.core.reply(f.caller(), {
        sessionId: alpha.sessionId,
        conversationId: conv,
        text,
      }),
    );
    const posts = f.posts();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("Short summary");
    expect(posts[0]).not.toContain(LONG_ANSWER_SEPARATOR);
    expect(posts[0]).toContain("Full answer: https://");
    const canvases = f.writes("createLongAnswer");
    expect(canvases).toHaveLength(1);
    expect(canvases[0]!.args).toEqual([
      channel,
      "Fixture One: Short summary",
      text,
    ]);
  },
  timeout,
);

test(
  "SA2 paragraph cut ends at the last paragraph break before the limit",
  async () => {
    const { f, alpha, conv } = await setup();
    const block = (letter: string) => letter.repeat(400);
    const text = [
      block("a"),
      block("b"),
      block("c"),
      block("d"),
      block("e"),
    ].join("\n\n");
    value(
      await f.core.reply(f.caller(), {
        sessionId: alpha.sessionId,
        conversationId: conv,
        text,
      }),
    );
    const posts = f.posts();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain(block("a") + "\n\n" + block("b"));
    expect(posts[0]).not.toContain(block("c"));
    expect(posts[0]).toContain("Full answer: https://");
    const canvases = f.writes("createLongAnswer");
    expect(canvases).toHaveLength(1);
    expect(canvases[0]!.args[2]).toBe(text);
  },
  timeout,
);

test(
  "SA2 whitespace cut stays within the limit when no paragraph break fits",
  async () => {
    const { f, alpha, conv } = await setup();
    const text = "w ".repeat(1000);
    value(
      await f.core.reply(f.caller(), {
        sessionId: alpha.sessionId,
        conversationId: conv,
        text,
      }),
    );
    expect(f.posts()).toHaveLength(1);
    expect(shortOf(f.posts()[0]).length).toBeLessThanOrEqual(
      LIMITS.shortAnswer,
    );
    expect(text.startsWith(shortOf(f.posts()[0]))).toBe(true);
    expect(f.posts()[0]).toContain("Full answer: https://");
    const canvases = f.writes("createLongAnswer");
    expect(canvases).toHaveLength(1);
    expect(canvases[0]!.args[2]).toBe(text);
  },
  timeout,
);

test(
  "SA2 edges hold the limit at 1,200, split at 1,201 and hard-cut without whitespace",
  async () => {
    for (const [name, text] of [
      ["split-1201", "q ".repeat(600) + "q"],
      [
        "overlong-short",
        "s".repeat(1300) + "\n" + LONG_ANSWER_SEPARATOR + "\nDetail",
      ],
      ["no-whitespace", "n".repeat(2000)],
    ] as const) {
      const { f, alpha, conv } = await setup();
      value(
        await f.core.reply(f.caller(), {
          sessionId: alpha.sessionId,
          conversationId: conv,
          text,
        }),
      );
      expect(f.posts()).toHaveLength(1);
      const short = shortOf(f.posts()[0]);
      expect(short.length).toBeLessThanOrEqual(LIMITS.shortAnswer);
      expect(f.posts()[0]).not.toContain(LONG_ANSWER_SEPARATOR);
      const canvases = f.writes("createLongAnswer");
      expect(canvases).toHaveLength(1);
      expect(canvases[0]!.args[2]).toBe(text);
      if (name === "no-whitespace")
        expect(short.length).toBe(LIMITS.shortAnswer);
    }
    const { f, alpha, conv } = await setup();
    const exact = "m".repeat(1200);
    value(
      await f.core.reply(f.caller(), {
        sessionId: alpha.sessionId,
        conversationId: conv,
        text: exact,
      }),
    );
    expect(f.posts()).toEqual([prefix + " " + exact]);
    expect(f.writes("createLongAnswer")).toEqual([]);
  },
  timeout,
);

test(
  "SA5 short answer posts as is with no canvas call",
  async () => {
    const { f, alpha, conv } = await setup();
    const text = "v".repeat(500);
    value(
      await f.core.reply(f.caller(), {
        sessionId: alpha.sessionId,
        conversationId: conv,
        text,
      }),
    );
    expect(f.posts()).toEqual([prefix + " " + text]);
    expect(f.writes("createLongAnswer")).toEqual([]);
  },
  timeout,
);

const fallbackNote =
  "(The full answer could not be posted as a canvas. Ask Fixture Alpha's agent for the detail.)";

test(
  "SA3 canvas refusal falls back to the short part plus the canvas note",
  async () => {
    const { f, alpha, conv } = await setup();
    const text =
      "Short summary\n" + LONG_ANSWER_SEPARATOR + "\nThe full detail.";
    f.chat.nextWrite = { kind: "refused", reason: "canvas_unavailable" };
    const out = value(
      await f.core.reply(f.caller(), {
        sessionId: alpha.sessionId,
        conversationId: conv,
        text,
      }),
    );
    expect(out.conversationId).toBe(conv);
    expect(
      f.chat.calls.filter((call) => call.name === "createLongAnswer"),
    ).toHaveLength(1);
    const posts = f.posts();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("Short summary");
    expect(posts[0]).toContain(fallbackNote);
    expect(posts[0]).not.toContain("Full answer: https");
    expect(
      f.rows("reply_owed WHERE conversation_id = ?", "answered", conv),
    ).toEqual([{ answered: 1 }]);
    const agents = f.rows(
      "thread_messages WHERE kind = 'agent'",
      "chat_message_id,text",
    );
    expect(agents).toHaveLength(1);
    expect(f.col("thread_messages WHERE kind = 'agent'", "text")).toEqual([
      "Fixture Alpha's agent: Short summary " + fallbackNote,
    ]);
    expect(JSON.stringify(f.logged)).toContain("canvas_unavailable");
  },
  timeout,
);

test(
  "SA3 disabled canvases fall back to the short part plus the note",
  async () => {
    const f = await baseFixture();
    const alpha = f.bind();
    await f.emit("root");
    const first = f.read(alpha.sessionId).items[0]!;
    f.ack(alpha.sessionId, [first.itemId]);
    const conv = first.conversationId;
    if (!conv) throw new Error("Expected a Slack conversation ID");
    const offline = new FakeChatPort(f.config.slack.teamId, {
      longAnswers: false,
    });
    const core = createCoreBase(
      createCoreContext({ ...f.deps, chat: offline }),
    );
    await offline.start(core.chatHandlers);
    const text =
      "Short summary\n" + LONG_ANSWER_SEPARATOR + "\nThe full detail.";
    const out = value(
      await core.reply(f.caller(), {
        sessionId: alpha.sessionId,
        conversationId: conv,
        text,
      }),
    );
    expect(out.conversationId).toBe(conv);
    expect(
      offline.calls.filter((call) => call.name === "createLongAnswer"),
    ).toHaveLength(1);
    const posts = offline.writes
      .filter((call) => call.name === "postText")
      .map((call) => call.args[1]);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("Short summary");
    expect(posts[0]).toContain(fallbackNote);
    expect(
      f.rows("reply_owed WHERE conversation_id = ?", "answered", conv),
    ).toEqual([{ answered: 1 }]);
    expect(JSON.stringify(f.logged)).toContain("canvas_unavailable");
  },
  timeout,
);

test(
  "B1B-CANVAS1 canvas refusal on a project reply still posts the fallback thread",
  async () => {
    const f = await baseFixture();
    const alpha = f.bind();
    const text =
      "Short summary\n" + LONG_ANSWER_SEPARATOR + "\nThe full detail.";
    f.chat.nextWrite = { kind: "refused", reason: "canvas_unavailable" };
    const out = value(
      await f.core.reply(f.caller(), {
        sessionId: alpha.sessionId,
        projectId: p1,
        text,
      }),
    );
    expect(out.conversationId).toBeDefined();
    const posts = f.posts();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("Short summary");
    expect(posts[0]).toContain(fallbackNote);
    expect(posts[0]).not.toContain("Full answer: https");
    const convs = f.rows("conversations");
    expect(convs).toHaveLength(1);
    expect(convs[0]).toMatchObject({
      conversation_id: out.conversationId,
      person_id: "per_a",
      project_id: p1,
      session_id: alpha.sessionId,
    });
    expect(f.rows("thread_messages WHERE kind = 'agent'")).toHaveLength(1);
    expect(JSON.stringify(f.logged)).toContain("canvas_unavailable");
  },
  timeout,
);
