// [integration] Real Git and Bun selection in an isolated project.
import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

test("test:changed builds first and selects only tests importing the changed tool or memory source", () => {
  const scripts = (
    JSON.parse(
      readFileSync(resolve(import.meta.dir, "../../package.json"), "utf8"),
    ) as {
      scripts: Record<string, string>;
    }
  ).scripts;
  expect(scripts["test:changed"]).toBeDefined();
  const root = mkdtempSync(join(tmpdir(), "forge-test-changed-"));
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  try {
    put(
      "package.json",
      JSON.stringify({
        private: true,
        scripts: {
          "test:changed": scripts["test:changed"],
          build: "bun -e 'console.log(\"BUILD_FIRST\")'",
        },
      }),
    );
    if (existsSync(resolve(import.meta.dir, "../../tools/test-changed.ts"))) {
      put(
        "tools/test-changed.ts",
        readFileSync(
          resolve(import.meta.dir, "../../tools/test-changed.ts"),
          "utf8",
        ),
      );
    }
    for (const [source, tests] of [
      [
        "tools/lane.ts",
        ["test/tools/lane.test.ts", "test/tools/lane.integration.test.ts"],
      ],
      [
        "src/blocks/memory/index.cts",
        [
          "test/blocks/memory/rules.test.ts",
          "test/blocks/memory/recipes.integration.test.ts",
        ],
      ],
      ["src/core/state/index.ts", ["test/core/state/state.test.ts"]],
    ] as const) {
      put(source, "export const value = 1;\n");
      for (const file of tests) {
        const relative = file.startsWith("test/tools/")
          ? "../../tools/lane.ts"
          : file.includes("memory/")
            ? "../../../src/blocks/memory/index.cts"
            : "../../../src/core/state/index.ts";
        put(
          file,
          `import {test, expect} from "bun:test"; import {value} from ${JSON.stringify(relative)}; test("selected", () => {expect(value).toBe(2); console.log(${JSON.stringify(`SELECTED:${file}`)});}, 1000);`,
        );
      }
    }
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        timeout: 15_000,
      });
    git("init", "--initial-branch=main");
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-m",
      "fixture",
    );
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    for (const [source, expected] of [
      [
        "tools/lane.ts",
        ["test/tools/lane.test.ts", "test/tools/lane.integration.test.ts"],
      ],
      [
        "src/blocks/memory/index.cts",
        [
          "test/blocks/memory/rules.test.ts",
          "test/blocks/memory/recipes.integration.test.ts",
        ],
      ],
      ["src/core/state/index.ts", ["test/core/state/state.test.ts"]],
    ] as const) {
      put(source, "export const value = 2;\n");
      const result = spawnSync(process.execPath, ["run", "test:changed"], {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
      });
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status, output).toBe(0);
      if (source !== "src/core/state/index.ts") {
        const fallback = output
          .split("\n")
          .find(
            (line) =>
              line.startsWith("test:changed: bun test ") &&
              !line.includes("--changed="),
          );
        expect(fallback).toContain("--parallel");
      }
      expect(output.match(/^BUILD_FIRST\r?$/gm)).toHaveLength(1);
      expect(output.indexOf("BUILD_FIRST")).toBeLessThan(
        output.indexOf("SELECTED:"),
      );
      expect(
        [...output.matchAll(/^SELECTED:(.+)$/gm)]
          .map((match) => match[1]!.trim())
          .sort(),
      ).toEqual([...expected].sort());
      git("restore", source);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

// Use the repository's real source/import graph, rather than static-import stand-ins.
for (const scenario of ["tools", "memory", "diverged", "packed"] as const) {
  test(`test:changed covers the real repository graph: ${scenario}`, () => {
    const repo = resolve(import.meta.dir, "../..");
    const root = mkdtempSync(join(tmpdir(), "forge-changed-real-"));
    const put = (file: string, text: string) => {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    };
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        timeout: 15_000,
      }).trim();
    try {
      const files = execFileSync("git", ["ls-files", "-z"], {
        cwd: repo,
        encoding: "utf8",
      })
        .split("\0")
        .filter(Boolean);
      for (const file of files) {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        copyFileSync(join(repo, file), join(root, file));
        if (file.endsWith(".test.ts"))
          put(
            file,
            `${readFileSync(join(root, file), "utf8")}\nimport { test as selectionProbe } from "bun:test"; selectionProbe("FORGE_SELECTION_PROBE", () => {}, 1000);\n`,
          );
      }
      symlinkSync(
        join(repo, "node_modules"),
        join(root, "node_modules"),
        "junction",
      );
      if (existsSync(join(repo, "tools/test-changed.ts")))
        put(
          "tools/test-changed.ts",
          readFileSync(join(repo, "tools/test-changed.ts"), "utf8"),
        );
      const pkg = JSON.parse(
        readFileSync(join(root, "package.json"), "utf8"),
      ) as { scripts: Record<string, string> };
      pkg.scripts["build"] = "bun -e 'console.log(\"BUILD_FIRST\")'";
      delete pkg.scripts["prebuild"];
      delete pkg.scripts["postbuild"];
      // The actual pack smoke is checked separately; this fixture verifies routing to it.
      pkg.scripts["test:pack"] =
        "bun -e 'console.log(\"PREPARED_PACKED_CONSUMER\")'";
      put("package.json", JSON.stringify(pkg));
      git("init", "--initial-branch=main");
      git("add", ".");
      const commit = () =>
        git(
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.test",
          "commit",
          "-m",
          "fixture",
          "--quiet",
        );
      commit();
      const base = git("rev-parse", "HEAD");
      git("update-ref", "refs/remotes/origin/main", base);
      if (scenario === "diverged") {
        put(
          "test/blocks/memory/rules.test.ts",
          `${readFileSync(join(root, "test/blocks/memory/rules.test.ts"), "utf8")}\n`,
        );
        git("add", ".");
        commit();
        git("update-ref", "refs/remotes/origin/main", "HEAD");
        git("checkout", "--quiet", "-b", "worker", base);
      }
      const target =
        scenario === "memory"
          ? "src/blocks/memory/index.cts"
          : scenario === "packed"
            ? "test/templates/delivery/packed.integration.test.ts"
            : "tools/lane.ts";
      put(target, `${readFileSync(join(root, target), "utf8")}\n`);
      git("add", ".");
      commit();
      const result = spawnSync(
        process.execPath,
        ["run", "test:changed", "--test-name-pattern=^FORGE_SELECTION_PROBE$"],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 30_000,
          env: { ...process.env, FORGE_DEVICE_ROOT: join(root, "device") },
        },
      );
      const output = `${result.stdout}\n${result.stderr}`.replaceAll("\\", "/");
      expect(result.status, output).toBe(0);
      expect(output).toContain("BUILD_FIRST");
      console.log(`REAL_GRAPH:${scenario}\n${output}`);
      if (scenario === "packed") {
        expect(output).toContain("PREPARED_PACKED_CONSUMER");
      } else {
        const expected =
          scenario === "memory"
            ? [
                "test/blocks/memory/rules.test.ts",
                "test/blocks/memory/catalog.test.ts",
                "test/blocks/memory/recipes.integration.test.ts",
                "test/assembly/shared-store/shared-store.integration.test.ts",
              ]
            : [
                "test/tools/lane.integration.test.ts",
                "test/tools/lane-run.integration.test.ts",
                "test/tools/lane-close.integration.test.ts",
                "test/tools/digest.integration.test.ts",
              ];
        for (const file of expected) expect(output).toContain(file);
        if (scenario !== "memory") {
          expect(output).not.toContain("test/blocks/memory/");
          expect(output).not.toContain("test/core/state/");
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
}
