import { expect, setDefaultTimeout, test } from "bun:test";
import { jobRecord } from "../../tools/ci/ci-record.ts";
import { report, percentile } from "../../tools/ci/ci-report.ts";
import f from "./fixtures/ci-report.json" with { type: "json" };
setDefaultTimeout(1000);
test("record includes new files and attempt without double-counting failure summaries", () => {
  expect(jobRecord(f.log, f.env, f.timings, 60000)).toEqual(f.record);
});
test("nearest rank percentiles and empty samples", () => {
  expect(percentile([10, 1, 9, 2, 8, 3, 7, 4, 6, 5], 0.5)).toBe(5);
  expect(percentile([10, 1, 9, 2, 8, 3, 7, 4, 6, 5], 0.9)).toBe(9);
  expect(percentile([], 0.9)).toBeUndefined();
});
test.each(f.cases)("$name", ({ attempts, includes }) => {
  const output = report(attempts);
  for (const line of includes) expect(output).toContain(line);
});
