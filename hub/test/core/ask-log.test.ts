import { expect, test } from "bun:test";
import { a, p1, value } from "./fixture.ts";
import {
  askFixture,
  button,
  choices,
  digit,
  question,
  scriptedChat,
  slackA,
} from "./fakes.ts";

const timeout = 30_000;

test(
  "L1: ask, delivery and answer paths keep payloads out of logs",
  async () => {
    const f = await askFixture(
      scriptedChat(new Map([[slackA, { kind: "unknown" }]])),
    );
    const first = value(await f.choice());
    f.asks.answerAction(button(first.askId, "L1"));
    const second = value(await f.choice());
    f.asks.answerDigit(digit(second.askId + " 1"));
    const { sessionId } = f.store.sessions.createUnboundSession(a, p1, "t3");
    expect(await f.choice({ sessionId })).toMatchObject({
      error: { code: "REPLY_ONLY" },
    });
    const out = JSON.stringify(f.logged);
    for (const text of [
      question,
      ...choices.map(({ label }) => label),
      f.config.dataDir,
      a.displayName,
    ])
      expect(out).not.toContain(text);
  },
  timeout,
);
