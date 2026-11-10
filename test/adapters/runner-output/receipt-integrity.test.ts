import { expect, test } from "bun:test";
import { createRunnerOutput } from "../../../src/adapters/runner-output/index.ts";

const output = createRunnerOutput();
const passing = "Tests: 1 passed, 1 total";
for (const json of [
  '{"numTotalTests":1,"numFailedTests":1,"success":false}',
  '{"numTotalTests":0,"numFailedTests":0,"success":true}',
  '{"numTotalTests":',
  '{"numFailedTests":1}',
] as const) {
  test(`structured evidence ${json} cannot be hidden by passing text`, () => {
    for (const reverse of [false, true]) {
      const summaries = reverse ? [passing, json] : [json, passing];
      for (const [stdout, stderr] of [
        [summaries.join("\n"), ""],
        ["", summaries.join("\n")],
        summaries,
      ]) {
        const recognizer = output.recognize("auto");
        for (const [stream, text] of [
          ["stdout", stdout],
          ["stderr", stderr],
        ] as const)
          for (const byte of Buffer.from(text!))
            recognizer.push(stream, Uint8Array.of(byte));
        for (const report of [
          output.parse(stdout!, stderr!, "auto"),
          recognizer.report(),
        ])
          expect(
            report.kind === "malformed" ||
              (report.kind === "recognized" &&
                (report.testCount === 0 || report.failed! > 0)),
          ).toBe(true);
      }
    }
  }, 1000);
}

for (const evidence of [
  "Tests: 0 total",
  "No tests found",
  "Tests: FAILED TO PARSE TOTAL",
  "Tests: 1 failed, 1 total",
  "Tests  0 passed (0)",
  "0 pass\n0 fail\nRan 0 tests across 0 files.",
  "0 pass\n1 fail\nRan ? tests across 1 file.",
  "1 pass\n0 fail\nRan ? tests across 1 file.",
  "1 pass\n0 fail",
  "1 fail",
  "Ran 1 test across 1 file.",
] as const) {
  test(`mixed summaries retain ${evidence} in every order and stream`, () => {
    const baseline = output.parse(evidence, "", "auto");
    for (const reverse of [false, true]) {
      const summaries = reverse ? [passing, evidence] : [evidence, passing];
      for (const [stdout, stderr] of [
        [summaries.join("\n"), ""],
        ["", summaries.join("\n")],
        summaries,
      ]) {
        const recognizer = output.recognize("auto");
        for (const [stream, text] of [
          ["stdout", stdout],
          ["stderr", stderr],
        ] as const)
          for (const byte of Buffer.from(text!))
            recognizer.push(stream, Uint8Array.of(byte));
        const report = recognizer.report();
        expect(report).toMatchObject({
          kind: baseline.kind,
          testCount: baseline.testCount,
          failed: baseline.failed,
        });
        expect(recognizer.report()).toEqual(report);
      }
    }
  }, 1000);
}

test("a single passing summary keeps its count and status", () => {
  expect(output.parse(passing, "", "auto")).toMatchObject({
    kind: "recognized",
    testCount: 1,
    failed: 0,
  });
}, 1000);
