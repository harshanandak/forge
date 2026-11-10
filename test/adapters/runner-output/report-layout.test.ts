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
        }, 1000);
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
    }, 1000);
