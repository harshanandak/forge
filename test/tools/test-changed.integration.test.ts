import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

test("test:changed selects affected tools or memory tests, excludes packed journeys and preserves failures", () => {
  const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const work = mkdtempSync(join(tmpdir(), "forge-test-changed-"));
  const scripts = {
    "test:changed": pkg.scripts["test:changed"],
    build: "bun -e 'console.log(\"BUILD_ONCE\")'",
  };
  const write = (path: string, contents: string) => {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), contents);
  };
  const run = (command: string, args: string[]) => {
    const result = spawnSync(command, args, {
      cwd: work,
      env: process.env,
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    return {
      code: result.status,
      output: `${result.stdout}\n${result.stderr}`,
    };
  };
  const git = (...args: string[]) => {
    const result = run("git", args);
    expect(result.code, result.output).toBe(0);
  };
  const selected = (output: string) =>
    [...output.matchAll(/^SELECTED:(.+)\r?$/gm)]
      .map((match) => match[1]!.trim())
      .sort();
  const tools = "test/tools/changed.test.ts";
  const serial = "test/tools/lane-run.integration.test.ts";
  const memory = "test/blocks/memory/changed.test.ts";
  const packed = "test/integration/changed/packed.integration.test.ts";
  const fixtures = [
    [tools, "../../tools/changed.ts"],
    [serial, "../../tools/serial.ts"],
    [memory, "../../../src/blocks/memory/changed.ts"],
    ["test/core/state/changed.test.ts", "../../../src/core/state/changed.ts"],
    [packed, "../../../tools/changed.ts"],
  ] as const;
  try {
    write("package.json", JSON.stringify({ type: "module", scripts }));
    for (const source of [
      "tools/changed.ts",
      "tools/serial.ts",
      "src/blocks/memory/changed.ts",
      "src/core/state/changed.ts",
    ])
      write(source, "export const value = true;\n");
    for (const [path, source] of fixtures)
      write(
        path,
        `import {test,expect} from "bun:test"; import {value} from ${JSON.stringify(source)}; test("selection",()=>{console.log(${JSON.stringify(`SELECTED:${path}`)});expect(value).toBe(true)},1000);`,
      );
    git("init", "-q");
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-qm",
      "base",
    );
    git("update-ref", "refs/remotes/origin/main", "HEAD");

    const check = (expected: string[], code = 0) => {
      const result = run(process.execPath, ["run", "test:changed"]);
      expect(result.code, result.output).toBe(code);
      expect(result.output.match(/^BUILD_ONCE\r?$/gm)).toHaveLength(1);
      expect(selected(result.output), result.output).toEqual(expected.sort());
      return result;
    };
    write("tools/changed.ts", "export const value = true; // tools change\n");
    check([tools]);
    git("restore", "tools/changed.ts");
    write(
      "src/blocks/memory/changed.ts",
      "export const value = true; // memory change\n",
    );
    check([memory]);

    // Exercise the serial command with changes that affect none of its files.
    const empty = run(process.execPath, [
      "test",
      "--timeout",
      "30000",
      "--changed=origin/main",
      serial,
    ]);
    expect(empty.code, empty.output).toBe(0);
    expect(selected(empty.output)).toEqual([]);

    git("restore", "src/blocks/memory/changed.ts");
    write("tools/serial.ts", "export const value = true; // serial change\n");
    check([serial]);
    write("tools/serial.ts", "export const value = false;\n");
    check([serial], 1);
    git("restore", "tools/serial.ts");
    write("tools/changed.ts", "export const value = false;\n");
    check([tools], 1);

    write(
      "package.json",
      JSON.stringify({ scripts: { build: scripts.build } }),
    );
    const missing = run(process.execPath, ["run", "test:changed"]);
    expect(missing.code, missing.output).not.toBe(0);
    expect(selected(missing.output)).toEqual([]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 30_000);
