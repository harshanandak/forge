import { expect, test } from "bun:test";
import { SUMMARY_KEY_MARKER } from "../../src/contract/chat.ts";
import type { AskInput } from "../../src/contract/mcp.ts";
import { value } from "./fixture.ts";
import { askFixture, rows } from "./fakes.ts";

const timeout = 30_000;
const secret = ["xoxb", "fixture123456"].join("-");
const variants = (text: string): readonly Partial<AskInput>[] => [
  { question: text },
  { choices: [{ id: "first", label: text }] },
];

test(
  "G1: authority asks and mismatched kind/action pairs are refused before posting",
  async () => {
    const f = await askFixture();
    const cases: readonly [Partial<AskInput>, string][] = [
      [{ requestedAction: "merge" }, "AUTHORITY_ASK_REFUSED"],
      [{ requestedAction: "work" }, "INPUT_INVALID"],
      [{ question: "Merge PR 12?" }, "AUTHORITY_ASK_REFUSED"],
      [
        { choices: [{ id: "first", label: "Deploy" }] },
        "AUTHORITY_ASK_REFUSED",
      ],
    ];
    for (const [input, code] of cases)
      expect(await f.choice(input)).toMatchObject({
        ok: false,
        error: { code },
      });
    expect(rows(f.db, "asks")).toEqual([]);
    expect(f.chat.calls).toEqual([]);
    expect(
      value(await f.choice({ question: "Will this emerge?" })).deliveredTo,
    ).toHaveLength(2);
  },
  timeout,
);

test(
  "G2: asks refuse synthetic secrets in either field without echoing them",
  async () => {
    const f = await askFixture();
    for (const input of variants(secret)) {
      const result = await f.choice(input);
      expect(result).toMatchObject({
        ok: false,
        error: { code: "SECRET_IN_TEXT" },
      });
      expect(JSON.stringify(result)).not.toContain(secret);
    }
    expect(rows(f.db, "asks")).toEqual([]);
    expect(f.chat.calls).toEqual([]);
  },
  timeout,
);

test(
  "G3: reserved summary markers are refused with a field pointer",
  async () => {
    const f = await askFixture();
    const inputs = variants(SUMMARY_KEY_MARKER + "fixture");
    expect(await f.choice(inputs[0])).toMatchObject({
      error: { code: "INPUT_INVALID", pointer: "/question" },
    });
    expect(await f.choice(inputs[1])).toMatchObject({
      error: { code: "INPUT_INVALID", pointer: "/choices/0/label" },
    });
    expect(rows(f.db, "asks")).toEqual([]);
    expect(f.chat.calls).toEqual([]);
  },
  timeout,
);
