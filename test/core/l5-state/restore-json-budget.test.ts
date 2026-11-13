import { expect, test } from "bun:test";
import { withinRestoreBudget } from "../../../src/core/state/restore-json.ts";

const list = (n: number, item: string) => `[${Array(n).fill(item).join(",")}]`;
const pairs = (n: number) =>
  `{${Array.from({ length: n }, (_, i) => `"k${i}":1`).join(",")}}`;
const deep = (n: number) => "[".repeat(n) + "]".repeat(n);
const flat = "[".repeat(40);

// [name, text, within the budget of 32 levels and 5,000 values (root, containers and scalars; labels excluded)]
const CASES: [string, string, boolean][] = [
  ["32 levels of depth", deep(32), true],
  ["33 levels of depth", deep(33), false],
  [
    "objects count as levels too",
    `${'{"a":'.repeat(32)}1${"}".repeat(32)}`,
    true,
  ],
  ["33 levels of objects", `${'{"a":'.repeat(33)}1${"}".repeat(33)}`, false],
  ["brackets inside a string are not levels", `["${flat}"]`, true],
  ["an escaped quote does not end the string", `["x\\"${flat}"]`, true],
  ["braces and an escaped quote inside a label", `{"a\\"${flat}":1}`, true],
  [
    "an escaped backslash ends the string at the next quote",
    `["\\\\"${deep(40)}`,
    false,
  ],
  ["5,000 values", list(4_999, "1"), true],
  ["5,001 values", list(5_000, "1"), false],
  ["object labels are not values", pairs(4_999), true],
  ["one more pair is one more value", pairs(5_000), false],
  ["a literal is one value however long", list(4_999, "-1234.5e+10"), true],
  ["a string is one value", list(4_999, '"a long string"'), true],
  ["5,001 string values", list(5_000, '"s"'), false],
  ["true, false and null are values", list(4_999, "null"), true],
  [
    "spaces do not split a literal or add values",
    `[ ${Array(2_000).fill("12").join(" , ")} ]`,
    true,
  ],
  [
    "text that is not JSON still gets a budget",
    `${"[1,".repeat(6_000)}`,
    false,
  ],
];
for (const [name, text, within] of CASES)
  test(`the restore budget: ${name} is ${within ? "within" : "over"}`, () => {
    expect(withinRestoreBudget(text)).toBe(within);
  }, 10_000);
