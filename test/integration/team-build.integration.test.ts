import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
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
import { readJson, repoRoot } from "../structure/lib/repo.ts";

test("the team build emits only team artifacts and preserves the public output", () => {
  const files = (directory: string): string[] =>
    readdirSync(directory, { recursive: true, encoding: "utf8" })
      .map((path) => path.replaceAll("\\", "/"))
      .filter((path) => statSync(join(directory, path)).isFile())
      .sort();
  const publicFiles = files(join(repoRoot, "dist"));
  expect(publicFiles.length).toBeGreaterThan(0);
  expect(
    publicFiles.filter((path) => path.split("/").includes("team")),
  ).toEqual([]);
  const before = publicFiles.map((path) =>
    readFileSync(join(repoRoot, "dist", path)),
  );
  const scratch = mkdtempSync(join(tmpdir(), "team-build-"));
  try {
    cpSync(join(repoRoot, "team"), join(scratch, "team"), { recursive: true });
    cpSync(join(repoRoot, "package.json"), join(scratch, "package.json"));
    for (const directory of ["dist", "node_modules"])
      symlinkSync(
        join(repoRoot, directory),
        join(scratch, directory),
        "junction",
      );
    writeFileSync(join(scratch, "team/build-probe.test.ts"), "export {};\n");
    writeFileSync(
      join(scratch, "tsconfig.team.json"),
      JSON.stringify({
        ...(readJson("tsconfig.team.json") as object),
        extends: join(repoRoot, "tsconfig.build.json"),
      }),
    );
    const result = spawnSync(
      process.execPath,
      [
        join(repoRoot, "node_modules/typescript/bin/tsc"),
        "-p",
        join(scratch, "tsconfig.team.json"),
        "--outDir",
        join(scratch, "output"),
      ],
      { cwd: scratch, encoding: "utf8", timeout: 10_000, windowsHide: true },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(files(join(repoRoot, "dist"))).toEqual(publicFiles);
    expect(
      publicFiles.map((path) => readFileSync(join(repoRoot, "dist", path))),
    ).toEqual(before);
    const output = files(join(scratch, "output"));
    const sources = files(join(repoRoot, "team")).filter(
      (path) =>
        path.endsWith(".ts") &&
        !path.endsWith(".test.ts") &&
        !path.split("/").includes("test"),
    );
    expect(sources.length).toBeGreaterThan(0);
    const allowed = sources.flatMap((path) => {
      const base = path.slice(0, -".ts".length);
      expect(output).toContain(`${base}.js`);
      expect(output).toContain(`${base}.d.ts`);
      return [".js", ".js.map", ".d.ts", ".d.ts.map"].map((ext) => base + ext);
    });
    expect(output.filter((path) => !allowed.includes(path))).toEqual([]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 30_000);
