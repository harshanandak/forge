// [integration] Real Git and Bun selection in an isolated project.
import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
    ] as const) {
      put(source, "export const value = 2;\n");
      const result = spawnSync(process.execPath, ["run", "test:changed"], {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
      });
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status, output).toBe(0);
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
