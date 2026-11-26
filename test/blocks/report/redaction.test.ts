import { expect, test } from "bun:test";
import { withReportRuntime } from "./fixtures.ts";

test("FR-REDACT1 strips absolute, relative, drive, UNC, home, and URI paths from records and receipts", async () => {
  await withReportRuntime(async ({ file, records, history }) => {
    for (const path of [
      "/private/PosixFixture/output",
      "./RelativeFixture/output",
      "NestedFixture/src/file.txt",
      String.raw`C:\DriveFixture\output`,
      String.raw`\\UncFixture\share\output`,
      "~/HomeFixture/output",
      "file:///UriFixture/private/output",
    ]) {
      const receipt = await file({ message: `Cannot open ${path}` });
      expect(receipt.ok).toBe(true);
      expect(
        JSON.stringify([receipt, [...records.values()], history]),
      ).not.toContain(/[A-Za-z]+Fixture/.exec(path)![0]);
    }
    expect(records.size).toBe(1);
  });
}, 30_000);

test("FR-REDACT2 strips known labels and replaces unrecognized context with sentinels", async () => {
  await withReportRuntime(
    async ({ file, records, history }) => {
      const receipt = await file({
        message: "Add a tooltip in SecretProject and Secret Repository",
        kind: "suggest",
      });
      expect(receipt.ok).toBe(true);
      const record = [...records.values()][0]?.value;
      expect(record).toMatchObject({
        kind: "suggest",
        op: "unknown",
        code: "unknown",
        summary: "Add a tooltip in [redacted] and [redacted]",
        context: { forgeVersion: "unknown", os: "unknown", harness: "unknown" },
      });
      expect(JSON.stringify([record, history, receipt])).not.toMatch(
        /SecretProject|Secret Repository|CustomFixture/,
      );
    },
    {
      forgeVersion: "CustomFixture",
      os: "CustomFixture",
      harness: "CustomFixture",
      op: "CustomFixture",
    },
  );
}, 30_000);

test("FR-REDACT3 redacts token shapes, escaped prefixes, assignments, and password URIs before clipping", async () => {
  await withReportRuntime(async ({ file, records, history }) => {
    const message = String.raw`Cannot use embedded-fct_FixtureDevice sk-FixtureProvider ghp_FixtureGitHub token=FixtureGeneric postgres://who:FixturePassword@example.test/db ghp\u005fFixtureEscaped g%68p%5fFixturePercent ${"z".repeat(300)} fct_FixtureLate`;
    const receipt = await file({ message });
    expect(receipt.ok).toBe(true);
    const stored = JSON.stringify([receipt, [...records.values()], history]);
    expect(stored).not.toMatch(
      /Fixture(Device|Provider|GitHub|Generic|Password|Escaped|Percent|Late)/,
    );
    expect(stored).toContain("Cannot use");
  });
}, 30_000);

test("FR-REDACT4 replaces pasted file material, removes controls, and bounds the stored Unicode line", async () => {
  await withReportRuntime(async ({ file, records, history }) => {
    const receipts = [];
    receipts.push(
      await file({ message: 'The file is {"private":"PastedFixture"}' }),
    );
    receipts.push(
      await file({
        message: "Show a\u0000 label " + "😀".repeat(315),
        kind: "suggest",
      }),
    );
    expect(receipts.map(({ ok }) => ok)).toEqual([true, true]);
    const values = [...records.values()].map(
      ({ value }) => value as { summary: string },
    );
    expect(values[0]?.summary).toBe("[redacted]");
    expect(values[1]?.summary).toStartWith("Show a label ");
    expect([...(values[1]?.summary ?? "")]).toHaveLength(300);
    expect(Object.keys(values[1] ?? {}).sort()).toEqual(
      [
        "v",
        "fingerprintVersion",
        "fingerprint",
        "kind",
        "op",
        "code",
        "summary",
        "count",
        "firstSeen",
        "lastSeen",
        "context",
      ].sort(),
    );
    expect(JSON.stringify([values, history, receipts])).not.toMatch(
      /PastedFixture|\\u0000/,
    );
  });
}, 30_000);
