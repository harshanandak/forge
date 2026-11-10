import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRepoFiles, readJson, repoRoot } from "./lib/repo.ts";

test("team has a separate build entry without changing the public roots", () => {
  const pkg = readJson("package.json") as { scripts: Record<string, string> };
  expect(pkg.scripts.build).toBe("tsc -p tsconfig.build.json");
  expect(pkg.scripts["build:team"]).toBeString();
  expect(existsSync(join(repoRoot, "tsconfig.team.json"))).toBe(true);
  expect(readJson("tsconfig.build.json")).toHaveProperty("include", [
    "bin",
    "src",
  ]);
}, 30_000);

test("the team build emits only team artifacts and preserves the public output", () => {
  const pkg = readJson("package.json") as { scripts: Record<string, string> };
  expect(pkg.scripts["build:team"]).toBeString();
  const scratch = mkdtempSync(join(tmpdir(), "forge-team-build-"));
  const paths = listRepoFiles();
  const files = (directory: string): string[] =>
    readdirSync(directory, { recursive: true, encoding: "utf8" })
      .map((path) => path.replaceAll("\\", "/"))
      .filter((path) => statSync(join(directory, path)).isFile())
      .sort();
  try {
    for (const path of paths.filter((path) => !path.startsWith("test/")))
      cpSync(join(repoRoot, path), join(scratch, path));
    cpSync(join(repoRoot, "src/generated"), join(scratch, "src/generated"), {
      recursive: true,
    });
    symlinkSync(
      join(repoRoot, "node_modules"),
      join(scratch, "node_modules"),
      "junction",
    );
    writeFileSync(join(scratch, "team/build-probe.test.ts"), "export {};\n");
    const build = (args: string[]): void => {
      const result = spawnSync(process.execPath, args, {
        cwd: scratch,
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
    };
    build(["run", "build"]);
    const publicFiles = files(join(scratch, "dist"));
    const before = publicFiles.map((path) =>
      readFileSync(join(scratch, "dist", path)),
    );
    build(["run", "build:team"]);
    expect(files(join(scratch, "dist"))).toEqual(publicFiles);
    expect(
      publicFiles.map((path) => readFileSync(join(scratch, "dist", path))),
    ).toEqual(before);
    const output = files(join(scratch, "dist-team")).map((path) =>
      path.replace(/^team\//, ""),
    );
    const sources = paths.filter(
      (path) =>
        /^team\/.*\.ts$/.test(path) && !/(?:\.test\.ts$|\/test\/)/.test(path),
    );
    expect(sources.length).toBeGreaterThan(0);
    const allowed = sources.flatMap((path) => {
      const base = path.slice("team/".length, -".ts".length);
      expect(output).toContain(`${base}.js`);
      expect(output).toContain(`${base}.d.ts`);
      return [".js", ".js.map", ".d.ts", ".d.ts.map"].map((ext) => base + ext);
    });
    expect(output.filter((path) => !allowed.includes(path))).toEqual([]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 30_000);
