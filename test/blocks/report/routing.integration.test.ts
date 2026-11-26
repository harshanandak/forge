import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { dispatch, record } from "../../../src/surface/dispatch.ts";
import { withOwnerApproval } from "../../fixtures/owner-approval.mjs";
import { reportBlock, reportFixture } from "./fixtures.ts";

test("a work operation renamed to report still derives its issue prefix", async () => {
  using f = reportFixture();
  execFileSync("git", ["init", "--quiet", f.root], { timeout: 10_000 });
  execFileSync(
    "git",
    [
      "-C",
      f.root,
      "remote",
      "add",
      "origin",
      "https://example.invalid/renamed-work.git",
    ],
    { timeout: 10_000 },
  );
  f.configure({
    blocks: {
      work: {
        source: { builtin: "forge/work" },
        rename: { issue: "report" },
      },
    },
  });
  await f.withAssembly(async ({ cli }) => {
    const reply = await cli([
      "report",
      "create",
      "--input",
      '{"title":"Derived prefix"}',
    ]);
    expect(reply.envelope).toMatchObject({
      ok: true,
      op: "report.create",
    });
    expect((reply.envelope.result as { id: string }).id).toMatch(
      /^renamed-work-\d+$/,
    );
  });
  expect(f.wroteProject).toBe(true);
  expect((await f.read()).rows ?? []).toEqual([]);
}, 30_000);

test("a configured custom CLI alias owns report create without breaking other commands", async () => {
  using f = reportFixture();
  cpSync(resolve("examples/hello-block"), join(f.root, "hello"), {
    recursive: true,
  });
  const path = join(f.root, "hello/forge.block.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as {
    operations: Record<string, { cli?: string }>;
  };
  manifest.operations["hello.say"]!.cli = "report.create";
  writeFileSync(path, JSON.stringify(manifest));
  await f.withAssembly(async ({ assembly, options, cli }) => {
    const call = withOwnerApproval((op: string, input: unknown) =>
      dispatch(assembly.catalog, op, input, options),
    );
    const added = await call("block.add", { path: "./hello" });
    expect(added.ok).toBe(true);
    const admitted = await call("block.admit", {
      digest: record(added.result)?.digest,
    });
    expect(admitted.ok).toBe(true);
    for (const config of [undefined, { conflictThreshold: -1 }]) {
      if (config)
        f.configure({
          blocks: {
            hello: { source: { path: "./hello" } },
            memory: { config },
          },
        });
      const reply = await cli(["report", "create", "--name", "World"]);
      expect(reply.envelope).toMatchObject({
        ok: true,
        op: "hello.say",
        result: { message: "Hello, World!" },
      });
      expect((await cli(["catalog", "list"])).exitCode).toBe(0);
    }
    unlinkSync(join(f.root, "hello/index.cjs"));
    const refused = await cli([
      "report",
      "create",
      "Owned by the configured block",
    ]);
    expect(refused.envelope).toMatchObject({
      ok: false,
      error: { code: "PROVIDER_MISSING" },
    });
    expect(existsSync(f.records)).toBe(false);
  });
}, 30_000);

test("a failed renamed built-in report retains its resolved operation", async () => {
  using f = reportFixture();
  f.configure({
    blocks: { report: { ...reportBlock, rename: { report: "feedback" } } },
  });
  writeFileSync(f.device, "cannot open a directory here");
  await f.withAssembly(async ({ cli }) => {
    const reply = await cli(["feedback", "create", "Show a confirmation"]);
    expect(reply.envelope).toMatchObject({
      ok: false,
      op: "feedback.create",
      status: "FAIL",
      error: {
        code: "UNAVAILABLE",
        message: "Could not file a device report.",
      },
      warnings: [],
    });
    expect(reply.stdout.includes(f.work)).toBe(false);
  });
}, 30_000);
