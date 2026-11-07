import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { version } from "../../src/version.ts";
import { removeQuietly, spawnBudget } from "../spawn-budget.ts";

for (const entry of ["bin/forge.ts", "dist/bin/forge.js"]) {
  test(`${entry}: version loads no assembly modules and catalog discovery still works`, () => {
    const node = Bun.which("node");
    if (!node) throw new Error("Node runtime required");
    const root = mkdtempSync(join(tmpdir(), "forge-lazy-assembly-"));
    const bin = new URL(`../../${entry}`, import.meta.url);
    const assembly = new URL("../src/assembly/", bin).href;
    const trace = join(root, "modules.json");
    const hook = `import { registerHooks } from 'node:module';
      import { writeFileSync } from 'node:fs';
      const loaded = [];
      registerHooks({ load(url, context, next) {
        loaded.push(url);
        return next(url, context);
      }});
      process.once('exit', () => writeFileSync(${JSON.stringify(trace)}, JSON.stringify(loaded)));`;
    try {
      mkdirSync(join(root, ".forge"));
      writeFileSync(
        join(root, ".forge/config.yaml"),
        "schemaVersion: forge.config/1\nblocks: {}\n",
      );
      function run(args: string[]) {
        const result = spawnSync(
          node!,
          [
            "--import",
            `data:text/javascript,${encodeURIComponent(hook)}`,
            fileURLToPath(bin),
            ...args,
          ],
          {
            cwd: root,
            env: { ...process.env, FORGE_DEVICE_ROOT: join(root, "device") },
            encoding: "utf8",
            timeout: 15_000,
            windowsHide: true,
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr + result.stdout).toBe(0);
        const loaded = JSON.parse(readFileSync(trace, "utf8")) as string[];
        expect(loaded).toContain(bin.href);
        return {
          stdout: result.stdout,
          assembly: loaded.filter((url) => url.startsWith(assembly)),
        };
      }
      for (const flag of ["--version", "-v"]) {
        const result = run([flag]);
        expect(result.stdout).toBe(`${version}\n`);
        expect(result.assembly).toEqual([]);
      }
      const identity = run(["--version", "--json"]);
      expect(JSON.parse(identity.stdout) as unknown).toMatchObject({
        version,
        commit: entry.startsWith("dist/")
          ? (expect.stringMatching(/^[a-f0-9]{40}$/) as unknown)
          : null,
        dirty: expect.any(Boolean) as unknown,
      });
      expect(identity.assembly).toEqual([]);
      const help = run(["--help"]);
      expect(help.stdout).toStartWith("Usage: forge");
      expect(help.assembly).toContain(
        new URL("command" + (entry.endsWith(".ts") ? ".ts" : ".js"), assembly)
          .href,
      );
      const normal = run(["catalog", "describe", "config.show"]);
      expect(JSON.parse(normal.stdout)).toMatchObject({
        ok: true,
        result: { op: "config.show" },
      });
      expect(normal.assembly.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
}

test("asset builds outside a source repository record unknown identity and remain readable", () => {
  const node = Bun.which("node");
  if (!node) throw new Error("Node runtime required");
  const root = mkdtempSync(join(tmpdir(), "forge-archive-build-"));
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  const budget = spawnBudget(60_000);
  try {
    const archive = join(root, "archive");
    for (const directory of [
      "src",
      "schemas",
      "tools/gen",
      "dist/src",
      "dist/bin",
    ])
      mkdirSync(join(archive, directory), { recursive: true });
    for (const file of [
      "package.json",
      "tools/build-assets.ts",
      "tools/gen/write.ts",
      "dist/src/version.js",
      "dist/bin/forge.js",
    ])
      cpSync(join(repo, file), join(archive, file));
    for (const mode of ["no git", "parent repository", "git unavailable"]) {
      if (mode === "parent repository") {
        budget.run("git init", "git", ["init", "--quiet", root], {}, 0);
      }
      const env =
        mode === "git unavailable" ? { ...process.env, PATH: "" } : process.env;
      budget.run(
        `build-assets (${mode})`,
        node,
        [join(archive, "tools/build-assets.ts")],
        { cwd: archive, env },
        0,
      );
      const expected = { version, commit: "unknown", dirty: false };
      expect(
        JSON.parse(
          readFileSync(join(archive, "dist/build.json"), "utf8"),
        ) as unknown,
      ).toEqual(expected);
      const identity = budget.run(
        `forge --version (${mode})`,
        node,
        [join(archive, "dist/bin/forge.js"), "--version", "--json"],
        { cwd: archive, env },
        0,
      );
      expect(JSON.parse(identity.stdout) as unknown).toEqual(expected);
    }
  } finally {
    removeQuietly(root);
  }
}, 60_000);
