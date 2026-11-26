import { expect, test } from "bun:test";
import { LIMITS, LONG_ANSWER_SEPARATOR } from "../../src/contract/mcp.ts";
import { baseFixture, channel } from "./base-fixture.ts";
import { value } from "./fixture.ts";

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
