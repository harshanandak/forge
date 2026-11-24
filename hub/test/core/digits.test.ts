import { expect, test } from "bun:test";
import { createCoreStore } from "../../src/core/store-impl.ts";
import { FakeChatPort } from "../fakes/fake-chat.ts";
import { a, configPeople, value } from "./fixture.ts";
import { askFixture, asksOf, digit, rows, slackA, slackB } from "./fakes.ts";

const timeout = 30_000;
const instruction = {
  kind: "instruction",
  text: "Reply under the ask's card, or send <askId> <number>.",
} as const;

test(
  "F1: a bare digit binds to the older card in its thread",
  async () => {
    const slack = {
      mode: "socket",
      teamId: "T012ABC9XYZ",
      buttons: false,
    } as const;
    const f = await askFixture(new FakeChatPort(), { slack });
    const older = value(await f.request());
    const newer = value(await f.request());
    expect(f.chat.askCards[0]?.state).toEqual({
      kind: "open",
      digitFallback: true,
    });
    expect(
      f.asks.answerDigit(digit("1", "F1", slackA, "message-1")),
    ).toMatchObject({
      kind: "answered",
      outcome: {
        kind: "locked",
        answer: { askId: older.askId, source: "digit" },
      },
    });
    expect(
      Object.fromEntries(
        rows(f.db, "asks").map((row) => [String(row.ask_id), row.status]),
      ),
    ).toEqual({ [older.askId]: "answered", [newer.askId]: "open" });
  },
  timeout,
);

test(
  "F2: a top-level digit cannot pick the latest ask",
  async () => {
    const f = await askFixture();
    for (let i = 0; i < 2; i++) value(await f.choice({ to: [a.personId] }));
    expect(f.asks.answerDigit(digit("2"))).toEqual(instruction);
    expect(rows(f.db, "answer_attempts")).toEqual([]);
    expect(rows(f.db, "ask_answers")).toEqual([]);
  },
  timeout,
);

test(
  "F3: an explicit ask id binds only for its recipient",
  async () => {
    const f = await askFixture();
    const { askId } = value(await f.choice({ to: [a.personId] }));
    const event = digit(askId + " 2");
    const first = f.asks.answerDigit(event);
    expect(first).toMatchObject({
      kind: "answered",
      outcome: {
        kind: "locked",
        answer: { askId, choiceId: "second", source: "digit" },
      },
    });
    expect(f.asks.answerDigit(digit(askId + " 1", "F3b", slackB))).toEqual(
      instruction,
    );
    for (const text of ["hello there", "12"])
      expect(f.asks.answerDigit(digit(text))).toEqual({
        kind: "not_a_digit_reply",
      });
    const withoutRecipient = asksOf(
      createCoreStore({
        ...f.deps,
        people: configPeople(
          f.config.people.filter((p) => p.personId !== a.personId),
        ),
      }),
    );
    if (first.kind !== "answered")
      throw new Error("Expected a recorded digit answer");
    expect(withoutRecipient.answerDigit(event)).toEqual({
      kind: "answered",
      outcome: first.outcome,
    });
    expect(
      withoutRecipient.answerDigit({ ...event, eventKey: "F3-new" }),
    ).toEqual(instruction);
    expect(rows(f.db, "answer_attempts")).toHaveLength(1);
  },
  timeout,
);
