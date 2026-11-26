import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { reportFingerprint } from "../../../src/blocks/report/fingerprint.ts";
import { redactReport } from "../../../src/blocks/report/redact.ts";

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const dimensions = ["unknown", "unknown", "bug"] as const;

test("FR-FP1 canonicalizes paths, numbers, IDs, quoted text and whitespace", () => {
  const samples = [
    'Cannot open /tmp/one.txt at 17 (job-934, 550e8400-e29b-41d4-a716-446655440000) with "detail one"',
    String.raw`Cannot   open C:\temp\other.txt at 312 (job-910, e993104a-be87-4c09-bde9-72dce0aa4335) with "detail two"`,
    'Cannot open ./other/file.txt at 55 (job-2, e993104a-be87-4c09-bde9-72dce0aa4335) with "detail three"',
  ];
  const fingerprints = samples.map((message) =>
    reportFingerprint(sha256, dimensions, redactReport(message, [])),
  );
  expect(fingerprints[0]).toMatch(/^fp1:[a-f0-9]{64}$/);
  expect(new Set(fingerprints).size).toBe(1);
}, 30_000);

test("FR-FP2 frames version, operation, error code, kind and wording", () => {
  const baseline = reportFingerprint(sha256, dimensions, "Missing title");
  expect(baseline).toBe(
    `fp1:${sha256(JSON.stringify(["fp1", ...dimensions, "Missing title"]))}`,
  );
  expect(
    reportFingerprint(sha256, ["check.run", "unknown", "bug"], "Missing title"),
  ).not.toBe(baseline);
  expect(
    reportFingerprint(
      sha256,
      ["unknown", "OUTPUT_INVALID", "bug"],
      "Missing title",
    ),
  ).not.toBe(baseline);
  expect(
    reportFingerprint(
      sha256,
      ["unknown", "unknown", "missing"],
      "Missing title",
    ),
  ).not.toBe(baseline);
  expect(reportFingerprint(sha256, dimensions, "Missing label")).not.toBe(
    baseline,
  );
}, 30_000);

test("FR-FP3 hashes the complete redacted text beyond a display limit", () => {
  const prefix = "Display this suggestion " + "q".repeat(310);
  const first = reportFingerprint(sha256, dimensions, prefix + " first");
  expect(reportFingerprint(sha256, dimensions, prefix + " first")).toBe(first);
  expect(reportFingerprint(sha256, dimensions, prefix + " second")).not.toBe(
    first,
  );
}, 30_000);
