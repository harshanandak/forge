import { expect, test } from "bun:test";
import { createRunnerOutput } from "../../../src/adapters/runner-output/index.ts";
import { commandArguments } from "../../../src/blocks/check/command.ts";
const output = createRunnerOutput();

test("Bun summaries preserve total tests and failures on either stream", () => {
  for (const [text, total, failed] of [
    [" 3 pass\n 0 fail\nRan 3 tests across 2 files. [12.00ms]", 3, 0],
    [" 1 pass\n 1 skip\n 2 fail\nRan 4 tests across 2 files. [12.00ms]", 4, 2],
    [" 0 pass\n 0 fail\nRan 0 tests across 0 files.", 0, 0],
    [" 1 pass\n 0 fail\nRan 1 test across 1 file. [1ms]", 1, 0],
  ] as const) {
    for (const stream of ["stdout", "stderr"] as const) {
      const recognizer = output.recognize("auto");
      const bytes = Buffer.from(`\u001b[32m${text}\u001b[0m\r\n`);
      for (const byte of bytes) recognizer.push(stream, Uint8Array.of(byte));
      expect(recognizer.report()).toMatchObject({
        kind: "recognized",
        testCount: total,
        failed,
      });
    }
    expect(output.parse(text, "", "exit-code").kind).toBe("unknown");
  }
}, 1000);

test("Bun summaries require complete, safe counts from the same stream", () => {
  for (const text of [
    " 3 pass\n 0 fail",
    "Ran 3 tests across 2 files.",
    " 3 pass\nRan 3 tests across 2 files.",
    " 3 pass\n 4 fail\nRan 3 tests across 2 files.",
    " 3 pass\n 0 fail\nRan 2 tests across 2 files.",
    " 0 pass\n 0 fail\nRan 9007199254740992 tests across 2 files.",
  ]) {
    expect(output.parse(text, "", "auto").kind).toBe("malformed");
  }
  expect(
    output.parse("3 pass\n", "0 fail\nRan 3 tests across 2 files.", "auto")
      .kind,
  ).toBe("malformed");
  expect(output.parse("the build had 3 pass checks", "", "auto").kind).toBe(
    "unknown",
  );
}, 1000);

test("pytest summaries count outcomes without counting warnings, deselection or reruns", () => {
  const samples = [
    ["1 passed, 1 warning in 0.12s\r\n", 1, 0],
    [
      "======================== 1 passed, 1 warning in 0.12s ========================",
      1,
      0,
    ],
    [
      "1 failed, 2 passed, 1 skipped, 1 xfailed, 1 xpassed, 2 warnings in 0.42s",
      6,
      1,
    ],
    ["2 errors, 1 passed in 0.12s", 3, 2],
    ["1 error, 2 deselected, 1 warning, 1 rerun, 2 passed in 0.12s", 3, 1],
    [
      "2 reruns, 3 warnings, 4 deselected, 1 xpassed, 2 xfailed, 3 skipped, 4 errors, 5 failed, 6 passed in 0.12s",
      21,
      9,
    ],
  ] as const;
  for (const [text, testCount, failed] of samples)
    expect(output.parse(text, "", "auto")).toMatchObject({
      kind: "recognized",
      testCount,
      failed,
    });
  for (const text of [
    "1 mystery, 2 passed in 0.12s",
    "2 passed, 1 mystery in 0.12s",
    "1 warning, 1 mystery, 2 passed in 0.12s",
    "9007199254740992 passed in 0.12s",
    "9007199254740991 passed, 1 skipped in 0.12s",
  ])
    expect(output.parse(text, "", "auto")).toMatchObject({
      kind: "unknown",
      testCount: null,
      failed: null,
    });
}, 1000);

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

test("streamed output is recognized the same however it is chunked, and summaries far from the ends count", () => {
  const text = `${"line ü\n".repeat(20000)}Tests:       1 failed, 2 passed, 3 total\r\n${"line ü\n".repeat(20000)}`;
  const bytes = Buffer.from(text);
  for (const size of [1, 7, 4096, bytes.length]) {
    const recognizer = output.recognize("auto");
    for (let start = 0; start < bytes.length; start += size)
      recognizer.push("stdout", bytes.subarray(start, start + size));
    expect(recognizer.observed()).toEqual({ stdout: bytes.length, stderr: 0 });
    expect(recognizer.report()).toEqual(output.parse(text, "", "auto"));
    expect(recognizer.report()).toMatchObject({ testCount: 3, failed: 1 });
  }
}, 10000);

test("a structured report too large to read whole is malformed, never guessed", () => {
  const recognizer = output.recognize("auto");
  recognizer.push(
    "stdout",
    Buffer.from('{"numTotalTests":1,"numFailedTests":0,"x":"'),
  );
  recognizer.push("stdout", Buffer.alloc(8_388_608, "a"));
  recognizer.push("stdout", Buffer.from('"}'));
  const report = recognizer.report();
  expect(report.kind).toBe("malformed");
  expect(report.detail).toContain("cannot be read whole");
}, 10000);

test("an overflowing JSON object is malformed even when its counts lie past the retained prefix", () => {
  const recognizer = output.recognize("auto");
  recognizer.push("stdout", Buffer.from('{"testResults":"'));
  recognizer.push("stdout", Buffer.alloc(8_388_608, "a"));
  recognizer.push(
    "stdout",
    Buffer.from('","numTotalTests":1,"numFailedTests":1}'),
  );
  expect(recognizer.report().kind).toBe("malformed");
}, 10000);

test("only a line that parses as a pytest summary counts, and stdout wins over stderr", () => {
  const summary = "======== 1 failed, 2 passed in 0.10s ========";
  expect(
    output.parse(`${summary}\nupload finished in 3s\n`, "", "auto"),
  ).toMatchObject({ kind: "recognized", testCount: 3, failed: 1 });
  expect(
    output.parse(summary, "=== 5 passed in 0.20s ===", "auto"),
  ).toMatchObject({ kind: "recognized", testCount: 3, failed: 1 });
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
