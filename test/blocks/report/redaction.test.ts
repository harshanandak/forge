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

test.each([
  "Authorization: Bearer ghs_FixtureInstallation",
  "Authorization: Bearer FixtureOpaque.payload/signature==",
  "Failed to authenticate ghs_FixtureInstallation",
  "Delivery failed for report+FixtureMail@example.test",
])(
  "P1 omits the complete credential or email in %j",
  (message) => {
    const safe = redactReport(message, []);
    expect(safe).toContain("[redacted]");
    expect(safe).not.toMatch(/Fixture|example\.test|payload|signature/);
  },
  30_000,
);

test.each([
  String.raw`Refused password="Alpha\"PrivateTail"`,
  String.raw`Refused secret='Alpha\'PrivateTail'`,
  String.raw`Rejected "Alpha\"PrivateTail"`,
  String.raw`Rejected "Alpha\u0022PrivateTail"`,
])(
  "P2 redacts an escaped quoted value in %j",
  (message) => {
    const safe = redactReport(message, []);
    expect(safe).toContain("[redacted]");
    expect(safe).not.toMatch(/Alpha|PrivateTail/);
  },
  30_000,
);

test.each([
  "/home/alice/Project[Orchid]/config.yml",
  "/Users/Jane Doe",
  "/tmp/Private Customer Folder/log.txt",
  String.raw`C:\Users\Private [Customer]\log.txt`,
  String.raw`\\Private Host\Private Share\log.txt`,
  "relative[Orchid]/Private Folder/log.txt",
  "/tmp/Private, Customer (Folder)/log.txt",
])(
  "P3 redacts the complete path span in %j",
  (path) => {
    expect(redactReport(`Cannot open ${path}`, [])).toBe(
      "Cannot open [redacted]",
    );
  },
  30_000,
);

test.each(['Acme "Private" Repository', 'Acme "Private" sk-FixtureLabel'])(
  "FR-REDACT2 removes an intact known label %j before other substitutions",
  (label) => {
    expect(redactReport(`Add a tooltip in ${label}`, [label])).toBe(
      "Add a tooltip in [redacted]",
    );
  },
  30_000,
);
