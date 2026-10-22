import { expect, setDefaultTimeout, test } from "bun:test";
import { yamlConfigCodec as codec } from "../../../src/adapters/config-yaml/index.ts";
import { DEFAULT_PARSE_LIMITS } from "../../../src/contract/untrusted.ts";
import type { ConfigTextEdit } from "../../../src/ports/config-codec.ts";

setDefaultTimeout(30_000);
// Regression inputs from closed #89; Document may normalize style, but must report lost lines.
const inputs = [
  "values:\n  retries: 1\n  # Keep retries low\nblocks: {}\n",
  "values:\n  - 1\n  # Keep retries low\nblocks: {}\n",
  "values:\n  mode: |- # staging\n    auto\nblocks: {}\n",
  "a: old # retained\n",
  "a: { b: old }\n",
  "a: [ old ]\n",
  " \n\n",
  "a: |\n  old\nb: keep\n",
  "a: | # prose\n    old\nb: keep\n",
  "a: { x: 1, y: 'old', z: true } # flow\n",
  "a: { x: 1, y: 2, z: 3 }\n",
  "a: [ 'keep', 2, true ]\n",
  "a:\n  - 'keep' # item\n  - 2\n",
  "a: 1",
  "a:\n    x: 1\n",
  "a: 'old' # retained\n",
  "a: old\n",
  "a:\n",
  "a: # keep\n",
  "a:\n  - 'keep' # item\n",
  "a: [ 'keep' ]\n",
  "a: { x: 1, y: 2, }\n",
  "# header\n\na: 0x10\n\n# end",
  "blocks:\n  check:\n    reviewers:\n      - alice # primary",
  "a: 1 # unchanged\r\nb: 'old'\nc: 3\r\n",
];
for (const input of inputs)
  for (const nl of ["\n", "\r\n"]) {
    test(`Document preserves outside lines or warns: ${JSON.stringify(input)} ${JSON.stringify(nl)}`, () => {
      const before = input.replaceAll("\r\n", "\n").replaceAll("\n", nl);
      const ending = before.includes("\r\n") ? "\r\n" : "\n";
      const result = codec.edit!(before, [{ path: ["new"], value: 2 }]);
      expect(
        result.text.includes("\nnew: 2") || result.text.startsWith("new: 2"),
      ).toBe(true);
      expect(
        result.text.replace(`new: 2${ending}`, "") ===
          before + (before.endsWith(ending) ? "" : ending) ||
          result.formattingLost,
      ).toBe(true);
      expect(codec.decode(result.text, DEFAULT_PARSE_LIMITS).ok).toBe(true);
    });
  }
for (const [before, edits, after] of [
  [
    "a: 'old' # retained\n",
    [{ path: ["a"], value: "true" }],
    "a: 'true' # retained\n",
  ],
  [
    "a: |- # prose\n    old\nb: keep\n",
    [{ path: ["a"], value: false }],
    "a: false # prose\nb: keep\n",
  ],
  [
    "a:\n  - old\n  - kept # retained\n",
    [{ path: ["a", 0], value: "kept" }],
    "a:\n  - kept\n  - kept # retained\n",
  ],
  [
    "a:\n    x: 1\n",
    [{ path: ["a", "y"], value: { z: 2 } }],
    "a:\n    x: 1\n    y:\n        z: 2\n",
  ],
  [" \r\n\r\n", [{ path: ["a"], value: 1 }], " \r\n\r\na: 1\r\n"],
] satisfies Array<[string, ConfigTextEdit[], string]>) {
  test(`replacement metadata and indent: ${JSON.stringify(before)}`, () => {
    expect(codec.edit!(before, edits)).toEqual({
      text: after,
      formattingLost: false,
    });
  });
}
test("duplicate standalone comments are counted positionally", () => {
  const result = codec.edit!(
    "a:\n  b: 1\n  # same\nz:\n  b: 1\n  # same\nend: keep\n",
    [{ path: ["a"] }],
  );
  expect(result.formattingLost).toBe(true);
});
for (const items of [
  ["alice", "carol"],
  ["bob", "carol"],
  ["bob", "alice"],
  ["carol", "bob", "alice"],
]) {
  test(`sequence replacement ${items.join(",")}`, () => {
    const before =
      "# header\na:\n  - 'alice' # primary\n  - 'bob' # backup\n  - 'carol' # last\nb: 'unchanged' # outside\n";
    const result = codec.edit!(before, [{ path: ["a"], value: items }]);
    expect(result.text).toBe(
      `# header\na:\n${items.map((i) => `  - ${i}\n`).join("")}b: 'unchanged' # outside\n`,
    );
  });
}
