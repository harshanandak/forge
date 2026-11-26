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

test.each([
  ["Authorization: Bearer OpaqueFixture", "Bearer"],
  ["Authorization: Bearer OpaqueFixture", "Authorization"],
  ["Rejected Authorization: Bearer OpaqueFixture", "Authorization: Bearer"],
  ["Cannot use token=OpaqueFixture", "token"],
  ["Cannot use password=OpaqueFixture", "password"],
  ['Cannot use password="Alpha\\"OpaqueFixture"', "password"],
  ["Cannot use Bearer OpaqueFixture", "Opaque"],
  ["Failed ghs_AcmePrivateTail", "Acme"],
  ["Delivery failed for alice@acme.test", "Acme"],
  ["Cannot use Bearer Opaque%46ixture", "Bearer"],
])(
  "protects the entire sensitive value when a label overlaps %j",
  (message, label) => {
    expect(redactReport(message, [label])).not.toMatch(
      /Opaque|Fixture|PrivateTail|alice@|\.test/,
    );
  },
  30_000,
);

test.each(["Secret%50roject", "Secret\u200bProject"])(
  "redacts the known label revealed by normalization in %j",
  (encoded) => {
    expect(redactReport(`Add a tooltip in ${encoded}`, ["SecretProject"])).toBe(
      "Add a tooltip in [redacted]",
    );
  },
  30_000,
);

test.each([
  ["Cannot open /tmp/Acme/PrivateTail", "Acme"],
  ["Cannot open Acme /tmp/PrivateTail", "Acme /tmp"],
  ['Cannot open "Acme PrivateTail"', "Acme"],
  [
    'Cannot open Acme "PrivateTail" Repository',
    'Acme "PrivateTail" Repository',
  ],
  ["Delivery failed for alice@acme.test", "alice@acme"],
  [
    "Delivery failed for alice@acme.test repository",
    "alice@acme.test repository",
  ],
])(
  "merges a known label with an overlapping sensitive span in %j",
  (message, label) => {
    expect(redactReport(message, [label])).not.toMatch(
      /Acme|PrivateTail|alice|\.test|Repository/i,
    );
  },
  30_000,
);

test.each([
  'Cannot use password="Private Tail"',
  'Cannot use "password=PrivateTail"',
  'Cannot use Bearer "Private Tail"',
  'Cannot use "Bearer PrivateTail"',
  'Cannot email "private"@example.test',
  'Cannot email "private@example.test"',
  'Cannot open "/tmp/Private Tail"',
  'Cannot open /tmp/"Private Tail"',
  "Cannot open /tmp/private@example.test",
  "Cannot open private@example.test/file",
  "Cannot use token=/tmp/PrivateTail",
  "Cannot open /tmp/token=PrivateTail",
  "Cannot use Bearer private@example.test",
  "Cannot email private@example.test then Bearer PrivateTail",
])(
  "merges independently detected sensitive spans in %j",
  (message) => {
    expect(redactReport(message, [])).not.toMatch(/private|example\.test/i);
  },
  30_000,
);

test.each([
  "o'brien.x!y#z@example.test",
  "prefix!tag#name&other+mail@example.test",
  '"quoted local"@example.test',
  String.raw`"quoted \"local\""@example.test`,
])(
  "masks the entire email local part and domain in %j",
  (email) => {
    expect(redactReport(`Cannot email ${email} today`, [])).toBe(
      "Cannot email [redacted] today",
    );
  },
  30_000,
);
