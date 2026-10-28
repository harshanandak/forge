// [integration] Real repositories and worktrees, with all stores isolated under one temp folder.
import { expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssembly, localCall } from "../../../src/assembly/index.ts";
import { blockCapture } from "../../../src/assembly/capture.ts";
import { firstPartyBlocks } from "../../../src/assembly/first-party.ts";
import { runCli } from "../../../src/surface/cli.ts";
import { done, stageBlock } from "../../blocks/memory/lib.ts";

const env: Record<string, string> = {};
for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "TEMP", "TMP"])
  if (process.env[name] !== undefined) env[name] = process.env[name]!;
function git(root: string, ...args: string[]) {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=Forge Test",
      "-c",
      "user.email=test@example.invalid",
      ...args,
    ],
    {
      cwd: root,
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    },
  );
  if (result.error || result.status !== 0)
    throw new Error(result.error?.message ?? result.stderr);
}

test("device memory resolves checkout aliases through missing and invalid project configs", async () => {
  const work = mkdtempSync(join(tmpdir(), "forge-checkout-memory-"));
  const deviceRoot = join(work, "device");
  mkdirSync(deviceRoot);
  writeFileSync(
    join(deviceRoot, "memory-scopes.json"),
    JSON.stringify({ plain: "x", old: "y" }),
  );
  const staged = stageBlock("memory", join(work, "builtins"));
  const source = fileURLToPath(firstPartyBlocks["forge/memory"]!);
  const open = blockCapture.open.bind(blockCapture);
  const capture = spyOn(blockCapture, "open").mockImplementation((path) =>
    open(path === source ? staged : path),
  );
  try {
    for (const [folder, scope, invalid] of [
      ["old", "y", true],
      ["plain", "x", false],
    ] as const) {
      const root = join(work, folder);
      const linked = join(work, `${folder}-lane`);
      mkdirSync(root);
      git(root, "init", "--quiet");
      writeFileSync(join(root, "README"), "temporary repository\n");
      const file = join(root, ".forge/config.yaml");
      const original =
        "template: old\nworkflow: {}\nadapters: {}\nprotectedPaths: []\n";
      if (invalid) {
        mkdirSync(join(root, ".forge"));
        writeFileSync(file, original);
      }
      git(root, "add", ".");
      git(root, "commit", "--quiet", "-m", "fixture");
      git(root, "worktree", "add", "--quiet", linked);
      for (const checkout of [root, linked])
        mkdirSync(join(checkout, "nested"));
      let count = 0;
      for (const cwd of [
        root,
        join(root, "nested"),
        linked,
        join(linked, "nested"),
      ]) {
        const degraded = invalid && (cwd === root || cwd === linked);
        const assembly = await createAssembly({
          root: cwd,
          deviceRoot,
          providers: { env },
        });
        const call = async (args: string[]) => {
          const result = (
            await runCli(assembly.catalog, args, localCall(assembly))
          ).envelope;
          if (degraded && result.ok && args[0] === "memory") {
            const warning = result.warnings
              .map((entry) => entry.message)
              .join("\n");
            expect(warning).toContain(".forge/config.yaml");
            expect(warning).toContain("INPUT_INVALID");
            expect(warning).toContain("repo override");
            expect(warning).toContain("project-level memory");
          }
          return result;
        };
        try {
          const scoped = await call(["memory", "scope"]);
          expect(scoped, cwd).toMatchObject({ ok: true, result: { scope } });
          if (degraded) {
            expect(
              scoped.warnings.map((warning) => warning.message).join("\n"),
            ).toContain(".forge/config.yaml");
            expect(
              scoped.warnings.map((warning) => warning.message).join("\n"),
            ).toContain("repo override");
            expect(
              scoped.warnings.map((warning) => warning.message).join("\n"),
            ).toContain("project-level memory");
          } else expect(scoped.warnings).toEqual([]);
          const added = done(
            await call(
              count % 2 === 0
                ? [
                    "memory",
                    "add",
                    "--input",
                    '{"text":"checkout heron","level":"device"}',
                  ]
                : ["memory", "add", "checkout heron"],
            ),
          ) as { id: string; note: { scope?: string } };
          count += 1;
          expect(added.note.scope).toBe(scope);
          expect(done(await call(["memory", "show", added.id]))).toMatchObject({
            note: { scope },
          });
          const found = done(await call(["memory", "search", "heron"])) as {
            hits: { id: string; scope?: string }[];
          };
          expect(
            found.hits.some(
              (hit) => hit.id === added.id && hit.scope === scope,
            ),
          ).toBe(true);
          const rules = done(await call(["memory", "rules"])) as {
            text: { text: string };
          };
          expect(rules.text.text).toContain(`general 0, ${scope} ${count}.`);
          expect(rules.text.text).not.toContain("checkout heron");
          if (degraded) {
            for (const args of [
              ["issue", "list"],
              ["memory", "export", "--input", '{"level":"device"}'],
              [
                "memory",
                "add",
                "--input",
                '{"text":"refused","level":"project"}',
              ],
              [
                "memory",
                "search",
                "--input",
                '{"query":"heron","level":"project"}',
              ],
            ])
              expect((await call(args)).ok, args.join(" ")).toBe(false);
            if (cwd === root || cwd === linked)
              expect((await call(["config", "show"])).result).toMatchObject({
                valid: false,
              });
          }
          expect(existsSync(join(cwd, ".forge/state.sqlite"))).toBe(false);
        } finally {
          await assembly.close();
        }
      }
      if (invalid) expect(readFileSync(file, "utf8")).toBe(original);
      else expect(existsSync(join(root, ".forge"))).toBe(false);
    }
    const outside = await createAssembly({
      root: work,
      deviceRoot,
      providers: { env },
    });
    try {
      expect(
        done(
          (
            await runCli(
              outside.catalog,
              ["memory", "scope"],
              localCall(outside),
            )
          ).envelope,
        ),
      ).toEqual({ scope: "general" });
      expect(
        done(
          (
            await runCli(
              outside.catalog,
              ["memory", "add", "outside heron"],
              localCall(outside),
            )
          ).envelope,
        ),
      ).toMatchObject({ note: { scope: "general" } });
    } finally {
      await outside.close();
    }
  } finally {
    capture.mockRestore();
    rmSync(work, { recursive: true, force: true });
  }
}, 180_000);

test("device fallback handles arbitrary config load problems while short valid configs keep their override", async () => {
  const work = mkdtempSync(join(tmpdir(), "forge-memory-config-"));
  mkdirSync(join(work, ".forge"));
  const staged = stageBlock("memory", join(work, "builtins"));
  const source = fileURLToPath(firstPartyBlocks["forge/memory"]!);
  const open = blockCapture.open.bind(blockCapture);
  const capture = spyOn(blockCapture, "open").mockImplementation((path) =>
    open(path === source ? staged : path),
  );
  const file = join(work, ".forge/config.yaml");
  const assembly = await createAssembly({
    root: work,
    deviceRoot: join(work, "device"),
    providers: { env },
  });
  try {
    for (const config of [
      "blocks: [\n",
      "unexpected: true\n",
      "blocks:\n  memory:\n    typo: true\n",
    ]) {
      writeFileSync(file, config);
      const result = (
        await runCli(assembly.catalog, ["memory", "scope"], localCall(assembly))
      ).envelope;
      expect(result).toMatchObject({ ok: true, result: { scope: "general" } });
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(readFileSync(file, "utf8")).toBe(config);
    }
    writeFileSync(file, "blocks:\n  memory:\n    scope: repo:override\n");
    const result = (
      await runCli(assembly.catalog, ["memory", "scope"], localCall(assembly))
    ).envelope;
    expect(result).toMatchObject({
      ok: true,
      result: { scope: "repo:override" },
      warnings: [],
    });
    expect(
      done(
        (
          await runCli(
            assembly.catalog,
            ["config", "show"],
            localCall(assembly),
          )
        ).envelope,
      ),
    ).toMatchObject({ valid: true });
  } finally {
    await assembly.close();
    capture.mockRestore();
    rmSync(work, { recursive: true, force: true });
  }
}, 90_000);
