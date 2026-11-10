import { expect, test } from "bun:test";
import { createRunnerOutput } from "../../../src/adapters/runner-output/index.ts";

const output = createRunnerOutput();
const passing = "Tests: 1 passed, 1 total";
for (const failed of [1, 0]) {
  const value = { numTotalTests: 1, numFailedTests: failed, success: !failed };
  const empty = JSON.stringify({ padding: "", ...value });
  const long = JSON.stringify({
    padding: "x".repeat(65_537 - Buffer.byteLength(empty)),
    ...value,
  });
  for (const [layout, json] of [
    ["pretty", JSON.stringify(value, null, 2)],
    ["prefixed", "runner: " + JSON.stringify(value)],
    ["overlong", long],
  ] as const)
    for (const stream of ["stdout", "stderr"] as const)
      for (const bytewise of [false, true])
        test(`${layout} ${failed ? "failing" : "passing"} report on ${stream}, ${bytewise ? "bytewise" : "whole"}`, () => {
          if (layout === "overlong") {
            expect(Buffer.byteLength(json)).toBe(65_537);
            expect(json.indexOf('"numTotalTests"')).toBeGreaterThan(65_000);
          }
          const stdout =
            "runner setup\n" +
            passing +
            (stream === "stdout" ? "\n" + json : "");
          const stderr = stream === "stderr" ? json : "";
          const recognizer = output.recognize("auto");
          for (const [channel, text] of [
            ["stdout", stdout],
            ["stderr", stderr],
          ] as const) {
            const bytes = Buffer.from(text);
            if (bytewise)
              for (const byte of bytes)
                recognizer.push(channel, Uint8Array.of(byte));
            else recognizer.push(channel, bytes);
          }
          const report = recognizer.report();
          expect(report).toEqual(output.parse(stdout, stderr, "auto"));
          expect(recognizer.observed()).toEqual({
            stdout: Buffer.byteLength(stdout),
            stderr: Buffer.byteLength(stderr),
          });
          if (failed)
            expect(
              report.kind === "malformed" ||
                (report.kind === "recognized" && (report.failed ?? 0) > 0),
            ).toBe(true);
          else
            expect(report).toMatchObject({
              kind: "recognized",
              testCount: 1,
              failed: 0,
            });
          expect(recognizer.report()).toEqual(report);
        }, 10_000);
}

for (const key of ["numTotalTests", "numFailedTests"])
  for (const stream of ["stdout", "stderr"] as const)
    test(`incomplete property ${key} on ${stream} cannot hide behind passing text`, () => {
      const json = `runner: {\n  "${key}" \n :`;
      const stdout = passing + (stream === "stdout" ? "\n" + json : "");
      const stderr = stream === "stderr" ? json : "";
      const recognizer = output.recognize("auto");
      for (const [channel, text] of [
        ["stdout", stdout],
        ["stderr", stderr],
      ] as const)
        for (const byte of Buffer.from(text))
          recognizer.push(channel, Uint8Array.of(byte));
      expect(recognizer.report().kind).toBe("malformed");
      expect(output.parse(stdout, stderr, "auto").kind).toBe("malformed");
    }, 10_000);

const failedReport = { numTotalTests: 1, numFailedTests: 1, success: false };
const nestedFailure = JSON.stringify({
  numTotalTests: 1,
  numFailedTests: 0,
  reports: [failedReport],
});
for (const bytewise of [false, true])
  test(`a passing nested report envelope stays passing, ${bytewise ? "bytewise" : "whole"}`, () => {
    const text = `${passing}\nrunner: {"reports":[{"numTotalTests":1,"numFailedTests":0,"success":true}]}`;
    const recognizer = output.recognize("auto");
    const bytes = Buffer.from(text);
    if (bytewise)
      for (const byte of bytes) recognizer.push("stdout", Uint8Array.of(byte));
    else recognizer.push("stdout", bytes);
    const report = recognizer.report();
    expect(report).toEqual(output.parse(text, "", "auto"));
    expect(report).toMatchObject({
      kind: "recognized",
      testCount: 1,
      failed: 0,
    });
    expect(recognizer.report()).toEqual(report);
  }, 10_000);

for (const [name, text, malformedResult] of [
  [
    "unfinished string before a failing object",
    `${passing}\nlog: {"message":"unfinished\n${JSON.stringify(failedReport)}`,
    true,
  ],
  ["nested failure beside passing text", `${nestedFailure}\n${passing}`, true],
  [
    "malformed property without a summary",
    '{"other":0 "numFailedTests":1}',
    true,
  ],
  [
    "newline recovery before pretty failure",
    `${passing}\nlog: {"message":"unfinished\n${JSON.stringify(failedReport, null, 2)}`,
    false,
  ],
  [
    "nested failure in a prefixed object",
    `log: ${nestedFailure}\n${passing}`,
    false,
  ],
  [
    "newline recovery retains earlier report evidence",
    `${passing}\nlog: {"numTotalTests":1,"message":"unfinished\nrunner: {"numTotalTests":1,"numFailedTests":0,"success":true}`,
    true,
  ],
] as const)
  for (const bytewise of [false, true])
    test(`${name}, ${bytewise ? "bytewise" : "whole"}`, () => {
      const recognizer = output.recognize("auto");
      const bytes = Buffer.from(text);
      if (bytewise)
        for (const byte of bytes)
          recognizer.push("stdout", Uint8Array.of(byte));
      else recognizer.push("stdout", bytes);
      const report = recognizer.report();
      expect(report).toEqual(output.parse(text, "", "auto"));
      if (malformedResult) expect(report.kind).toBe("malformed");
      else expect(report).toMatchObject({ kind: "recognized", failed: 1 });
      expect(recognizer.report()).toEqual(report);
    }, 10_000);
