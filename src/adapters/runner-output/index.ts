import type {
  OutputReport,
  RunnerOutputPort,
} from "../../ports/runner-output.ts";
import { stripVTControlCharacters } from "node:util";

const unknown: OutputReport = {
  kind: "unknown",
  testCount: null,
  failed: null,
  detail:
    "Unrecognized output; result uses only the exit code, test count unknown",
};
const malformed: OutputReport = {
  kind: "malformed",
  testCount: null,
  failed: null,
  detail: "Recognized report is malformed or incomplete",
};
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function jsonReport(text: string): OutputReport {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return malformed;
  }
  if (typeof value !== "object" || value === null) return malformed;
  const report = value as Record<string, unknown>;
  // Jest and Vitest use these fields in their JSON reports.
  if (
    !count(report.numTotalTests) ||
    !count(report.numFailedTests) ||
    report.numFailedTests > report.numTotalTests
  )
    return malformed;
  if (report.success !== undefined && typeof report.success !== "boolean")
    return malformed;
  return {
    kind: "recognized",
    testCount: report.numTotalTests,
    failed:
      report.success === false
        ? Math.max(1, report.numFailedTests)
        : report.numFailedTests,
    detail: "Structured test report",
  };
}
export function createRunnerOutput(): RunnerOutputPort {
  return {
    parse(stdout, stderr, format) {
      if (format === "exit-code") return unknown;
      const text = stripVTControlCharacters(`${stdout}\n${stderr}`);
      const trimmed = stdout.trim();
      if (
        format === "json" ||
        /^\s*\{[\s\S]*"num(?:Total|Failed)Tests"/.test(stdout)
      )
        return jsonReport(trimmed);
      const jest = /^\s*Tests:\s*(.*?)\s*(\d+)\s+total\s*$/m.exec(text);
      if (jest) {
        const failed = /(\d+)\s+failed/.exec(jest[1] ?? "");
        return {
          kind: "recognized",
          testCount: Number(jest[2]),
          failed: Number(failed?.[1] ?? 0),
          detail: "Jest test summary",
        };
      }
      const vitest = /^\s*Tests\s+(.*?)\((\d+)\)\s*$/m.exec(text);
      if (vitest) {
        const failed = /(\d+)\s+failed/.exec(vitest[1] ?? "");
        return {
          kind: "recognized",
          testCount: Number(vitest[2]),
          failed: Number(failed?.[1] ?? 0),
          detail: "Vitest test summary",
        };
      }
      if (
        /no test(?:s| files)? (?:found|collected)|collected 0 items/i.test(text)
      )
        return {
          kind: "recognized",
          testCount: 0,
          failed: 0,
          detail: "Runner reported zero tests",
        };
      const pytest =
        /(?:={2,}\s*)?((?:\d+ (?:passed|failed|skipped|deselected|xfailed|xpassed|errors?)(?:, )?)+) in [\d.]+s(?:\s*={2,})?/g;
      const summaries = [...text.matchAll(pytest)];
      const summary = summaries.at(-1)?.[1];
      if (summary) {
        let total = 0,
          failed = 0;
        for (const match of summary.matchAll(
          /(\d+) (passed|failed|skipped|deselected|xfailed|xpassed|errors?)/g,
        )) {
          const n = Number(match[1]);
          if (match[2] !== "deselected") total += n;
          if (/failed|errors?/.test(match[2] ?? "") && match[2] !== "xfailed")
            failed += n;
        }
        return {
          kind: "recognized",
          testCount: total,
          failed,
          detail: "Pytest test summary",
        };
      }
      if (/^\s*Tests:|^\s*Tests\s+\d+.*\(|"numTotalTests"/m.test(text))
        return malformed;
      return unknown;
    },
  };
}
