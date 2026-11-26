import { expect, test } from "bun:test";
import { redactReport } from "../../../src/blocks/report/redact.ts";

test("FR-REDACT1 strips absolute, relative, drive, UNC, home and URI paths", () => {
  for (const path of [
    "/private/PosixFixture/output",
    "./RelativeFixture/output",
    "NestedFixture/src/file.txt",
    String.raw`C:\DriveFixture\output`,
    String.raw`\\UncFixture\share\output`,
    "~/HomeFixture/output",
    "file:///UriFixture/private/output",
  ]) {
    expect(redactReport(`Cannot open ${path}`, [])).toBe(
      "Cannot open [redacted]",
    );
  }
}, 30_000);

test("FR-REDACT2 removes known labels, including checkout directory names with spaces", () => {
  const labels = ["SecretProject", "Secret Repository"];
  expect(
    redactReport(
      "Add a tooltip in SecretProject and Secret Repository",
      labels,
    ),
  ).toBe("Add a tooltip in [redacted] and [redacted]");
  expect(redactReport("Cannot open /workspace/Secret Repository", labels)).toBe(
    "Cannot open [redacted]",
  );
}, 30_000);

test("FR-REDACT3 strips credential shapes, encoded prefixes, assignments and password URLs", () => {
  const line = String.raw`Cannot use embedded-fct_FixtureDevice sk-FixtureProvider ghp_FixtureGitHub token=FixtureGeneric ghp\u005fFixtureEscaped g%68p%5fFixturePercent postgres://who:FixturePassword@example.test/db`;
  const summary = redactReport(line, []);
  expect(summary).toStartWith("Cannot use");
  expect(summary).not.toContain("Fixture");
}, 30_000);

test("FR-REDACT4 replaces structured content and removes controls", () => {
  expect(redactReport('The file is {"private":"PastedFixture"}', [])).toBe(
    "[redacted]",
  );
  expect(redactReport("Show a\u0000 label", [])).toBe("Show a label");
}, 30_000);
