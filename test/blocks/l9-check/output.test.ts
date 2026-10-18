import { expect, test } from "bun:test";
import { createRunnerOutput } from "../../../src/adapters/runner-output/index.ts";
import { commandArguments } from "../../../src/blocks/check/command.ts";
const output = createRunnerOutput();

test("real runner summary shapes and structured reports preserve failure and count", () => {
  for (const [stdout, stderr, total, failed] of [
    [" Tests  1 passed (1)", "", 1, 0],
    ["", "Tests:       1 failed, 1 passed, 2 total", 2, 1],
    [
      "================ 2 passed, 1 skipped in 0.01s ================",
      "",
      3,
      0,
    ],
    ['{"numTotalTests":3,"numFailedTests":1}', "", 3, 1],
    ["No test files found, exiting with code 0", "", 0, 0],
  ] as const) {
    expect(output.parse(stdout, stderr, "auto")).toMatchObject({
      kind: "recognized",
      testCount: total,
      failed,
    });
  }
  for (const text of [
    '{"numTotalTests":',
    '{"numTotalTests":-1,"numFailedTests":0}',
    '{"numTotalTests":1,"numFailedTests":2}',
    "Tests: broken summary",
  ]) {
    expect(output.parse(text, "", "auto").kind).toBe("malformed");
  }
  expect(output.parse("custom project output", "", "auto").kind).toBe(
    "unknown",
  );
  expect(output.parse("bad json", "", "json").kind).toBe("malformed");
}, 1000);

test("declared commands split quoted arguments without executing shell syntax", () => {
  expect(commandArguments('tool "path with spaces" test')).toEqual([
    "tool",
    "path with spaces",
    "test",
  ]);
  expect(commandArguments('"C:\\program files\\tool.exe" ""')).toEqual([
    "C:\\program files\\tool.exe",
    "",
  ]);
  for (const command of [
    "tool && other",
    "tool;other",
    "tool | other",
    "tool > file",
    "tool `other`",
    "tool $(other)",
    'tool "unterminated',
    "",
  ]) {
    expect(() => commandArguments(command)).toThrow();
  }
}, 1000);
