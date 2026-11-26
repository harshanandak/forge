import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, join } from "node:path";
import { reportFingerprint } from "../../../src/blocks/report/fingerprint.ts";
import { redactReport } from "../../../src/blocks/report/redact.ts";
import { reportFixture } from "./fixtures.ts";

test("stable host and checkout labels redact without making nested cwd a label", async () => {
  using f = reportFixture("Secret Checkout's Copy");
  const nested = join(f.root, "NestedFixture");
  mkdirSync(nested);
  execFileSync("git", ["init", "--quiet", f.root], { timeout: 10_000 });
  f.configure({ blocks: {} });
  writeFileSync(
    join(f.root, ".forge/project.json"),
    JSON.stringify({
      schema: 1,
      id: "00000000-0000-4000-8000-000000000000",
      name: "ManifestLabelFixture",
    }),
  );
  const user = userInfo().username;
  const message = `NestedFixture belongs to ${basename(f.root)} for ${user} and Jane Doe from /Users/Jane Doe/docs under ManifestLabelFixture`;
  for (const [cwd, count] of [
    [f.root, 1],
    [nested, 2],
  ] as const) {
    await f.withAssembly(async ({ cli }) => {
      const reply = await cli(["report", "create", message]);
      expect(reply.envelope).toMatchObject({ ok: true, result: { count } });
    }, cwd);
  }
  const { rows, events } = await f.read();
  expect(rows).toHaveLength(1);
  expect((rows![0]!.value as { summary: string }).summary).toContain(
    "NestedFixture",
  );
  for (const label of [
    basename(f.root),
    user,
    "Jane Doe",
    "ManifestLabelFixture",
    "/Users/",
  ]) {
    expect(JSON.stringify([rows, events]).includes(label)).toBe(false);
  }
}, 30_000);

test("report events use internal identity and fingerprint the whole redacted line before clipping", async () => {
  using f = reportFixture("UntrackedFolderFixture");
  await f.withAssembly(async ({ assembly, cli }) => {
    const token = ["ghp", "A".repeat(36)].join("_");
    const prefix = "🙂".repeat(295);
    for (const suffix of [
      "alpha UntrackedFolderFixture",
      "beta UntrackedFolderFixture",
    ]) {
      const input = {
        message: `${prefix} ${token} ${suffix}`,
        kind: "suggest",
      };
      const reply = await assembly.catalog.invoke({
        schemaVersion: "forge.invocation/1",
        op: "report.create",
        requestId: "PrivateRequestFixture",
        caller: "agent",
        input,
        context: {
          actor: { kind: "agent", id: "PrivateActorFixture" },
          device: { id: assembly.deviceRoot },
          session: {
            id: "PrivateSessionFixture",
            harness: "PrivateHarnessFixture",
          },
        },
      });
      const fingerprint = reportFingerprint(
        (payload) => createHash("sha256").update(payload).digest("hex"),
        ["unknown", "unknown", "suggest"],
        redactReport(input.message, []),
      );
      expect(reply).toMatchObject({
        ok: true,
        result: { fingerprint, count: 1 },
      });
      expect(JSON.stringify(reply).includes(token)).toBe(false);
    }
    for (const text of [`--token ${token}`, "--help"]) {
      for (const mode of [[], ["--text"]]) {
        const refused = await cli([
          "report",
          "create",
          ...mode,
          `--token ${token}`,
        ]);
        expect(refused.exitCode).toBe(6);
        expect(refused.stdout.includes(token)).toBe(false);
      }
      expect((await cli(["report", "create", "--", text])).exitCode).toBe(0);
    }
    const { rows, events } = await f.read();
    expect(rows).toHaveLength(4);
    expect(events).toHaveLength(4);
    expect(JSON.stringify([rows, events]).includes("Private")).toBe(false);
    expect(JSON.stringify([rows, events]).includes(token)).toBe(false);
    const clipped = rows!
      .map(({ value }) => (value as { summary: string }).summary)
      .filter((summary) => summary.startsWith(prefix));
    expect(clipped).toEqual([prefix + " [red", prefix + " [red"]);
  });
}, 30_000);
