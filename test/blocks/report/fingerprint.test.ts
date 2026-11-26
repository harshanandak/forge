import { expect, test } from "bun:test";
import type { ResultEnvelope } from "../../../src/generated/types.ts";
import { hashReport, withReportRuntime } from "./fixtures.ts";

function fingerprint(result: ResultEnvelope): string | undefined {
  expect(result.ok).toBe(true);
  return result.ok
    ? (result.result as { fingerprint: string }).fingerprint
    : undefined;
}

test("FR-FP1 hashes equivalent paths, numbers, IDs, quotes, and whitespace together", async () => {
  await withReportRuntime(async ({ file }) => {
    const a = fingerprint(
      await file({
        message:
          'Cannot open /tmp/one.txt at 17 (job-934, 550e8400-e29b-41d4-a716-446655440000) with "detail one"',
      }),
    );
    const b = fingerprint(
      await file({
        message: String.raw`Cannot   open C:\temp\other.txt at 312 (job-910, e993104a-be87-4c09-bde9-72dce0aa4335) with "detail two"`,
      }),
    );
    const c = fingerprint(
      await file({
        message:
          'Cannot open ./other/file.txt at 55 (job-2, e993104a-be87-4c09-bde9-72dce0aa4335) with "detail three"',
      }),
    );
    expect(a).toMatch(/^fp1:[a-f0-9]{64}$/);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });
}, 30_000);

test("FR-FP2 frames op, code, kind and normalized wording in the versioned hash", async () => {
  await withReportRuntime(async ({ file, records }) => {
    const base = fingerprint(await file({ message: "Missing title" }));
    expect(base).toBe(
      `fp1:${hashReport(JSON.stringify(["fp1", "unknown", "unknown", "bug", "Missing title"]))}`,
    );
    expect(
      fingerprint(await file({ message: "Missing title", kind: "missing" })),
    ).not.toBe(base);
    expect(fingerprint(await file({ message: "Missing label" }))).not.toBe(
      base,
    );
    expect(
      [...records.values()].map(
        ({ value }) => (value as { kind: string }).kind,
      ),
    ).toEqual(["bug", "missing", "bug"]);
  });
}, 30_000);

test("FR-FP3 is stable across runtime, caller, and host context and includes text beyond the display cap", async () => {
  const message = "Display this suggestion " + "q".repeat(310);
  let first: string | undefined;
  await withReportRuntime(
    async ({ file }) => {
      first = fingerprint(await file({ message: message + " first" }, "human"));
    },
    { forgeVersion: "1.2.3", os: "linux", harness: "cli" },
  );
  await withReportRuntime(
    async ({ file, records }) => {
      expect(fingerprint(await file({ message: message + " first" }))).toBe(
        first,
      );
      expect(
        fingerprint(await file({ message: message + " second" })),
      ).not.toBe(first);
      const summaries = [...records.values()].map(
        ({ value }) => (value as { summary: string }).summary,
      );
      expect(summaries).toHaveLength(2);
      expect(summaries[0]).toEqual(summaries[1]);
    },
    { forgeVersion: "2.0.0", os: "win32", harness: "mcp" },
  );
}, 30_000);
