import { expect, setDefaultTimeout, test } from "bun:test";
import { yamlConfigCodec as codec } from "../../../src/adapters/config-yaml/index.ts";
import { DEFAULT_PARSE_LIMITS } from "../../../src/contract/untrusted.ts";

setDefaultTimeout(30_000);

const cases: ReadonlyArray<readonly [string, unknown, string]> = [
  ["a: old # retained\n", { a: { b: 1 } }, "a: { b: 1 } # retained\n"],
  ["a: old # retained\n", { a: [1, 2] }, "a: [ 1, 2 ] # retained\n"],
  ["a: { b: old }\n", { a: { b: { c: 1 } } }, "a: { b: { c: 1 } }\n"],
  ["a: [ old ]\n", { a: [[1, 2]] }, "a: [ [ 1, 2 ] ]\n"],
  [" \r\n\r\n", { a: 1, b: 2 }, " \r\n\r\na: 1\r\nb: 2\r\n"],
  ...["\n", "\r\n"].map((newline): readonly [string, unknown, string] => [
    `blocks:${newline}  check:${newline}    reviewers:${newline}      - alice # primary`,
    { blocks: { check: { reviewers: ["alice", "bob"] } } },
    `blocks:${newline}  check:${newline}    reviewers:${newline}      - alice # primary${newline}      - bob${newline}`,
  ]),
  [
    "a: |\r\n  old\r\nb: keep\r\n",
    { a: "new\nlines\n", b: "keep" },
    "a: |\r\n  new\r\n  lines\r\nb: keep\r\n",
  ],
  [
    "a: | # prose\n    old\nb: keep\n",
    { a: "new\nlines\n", b: "keep" },
    "a: | # prose\n    new\n    lines\nb: keep\n",
  ],
  [
    "a: 1 # unchanged\r\nb: 'old'\nc: 3\r\n",
    { a: 1, b: "new", c: 3 },
    "a: 1 # unchanged\r\nb: 'new'\nc: 3\r\n",
  ],
  [
    "a: { x: 1, y: 'old', z: true } # flow\n",
    { a: { x: 1, y: "new", z: true } },
    "a: { x: 1, y: 'new', z: true } # flow\n",
  ],
  ["a: { x: 1, y: 2, z: 3 }\n", { a: { x: 1, z: 3 } }, "a: { x: 1, z: 3 }\n"],
  ["a: { x: 1, y: 2 }\n", { a: { y: 2 } }, "a: { y: 2 }\n"],
  [
    "a: [ 'keep', 2, true ]\n",
    { a: ["keep", 3, true] },
    "a: [ 'keep', 3, true ]\n",
  ],
  [
    "a:\n  - 'keep' # item\n  - 2\n",
    { a: ["keep", 3] },
    "a:\n  - 'keep' # item\n  - 3\n",
  ],
  ["a: 1", { a: 1, b: 2 }, "a: 1\nb: 2\n"],
  [
    "a:\n    x: 1\n",
    { a: { x: 1, y: { z: 2 } } },
    "a:\n    x: 1\n    y:\n        z: 2\n",
  ],
  ["a: 'old' # retained\n", { a: "true" }, "a: 'true' # retained\n"],
  ["a: old\n", { a: "true" }, 'a: "true"\n'],
  ["a:\n", { a: { b: 1 } }, "a:\n  b: 1\n"],
  ["a: # keep\n", { a: { b: 1 } }, "a: # keep\n  b: 1\n"],
  [
    "a:\n  - 'keep' # item\n",
    { a: ["keep", 3] },
    "a:\n  - 'keep' # item\n  - 3\n",
  ],
  ["a: [ 'keep' ]\n", { a: ["keep", 3] }, "a: [ 'keep', 3 ]\n"],
  ["a: { x: 1, y: 2, }\n", { a: { x: 3, y: 2 } }, "a: { x: 3, y: 2, }\n"],
  ["# header\n\na: 0x10\n\n# end", { a: 16 }, "# header\n\na: 0x10\n\n# end"],
];

for (const [before, value, after] of cases) {
  test(`CST edit retains source outside changed values: ${JSON.stringify(before)}`, () => {
    const result = codec.edit(before, value);
    expect(result).toBe(after);
    expect(codec.decode(result, DEFAULT_PARSE_LIMITS)).toEqual({
      ok: true,
      value,
    });
  });
}
