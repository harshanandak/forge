import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { listRepoFiles, readRepoFiles } from "./lib/repo.ts";

function git(root: string, ...args: string[]): void {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    throw new Error(result.stdout + result.stderr, { cause: result.error });
}

function write(root: string, path: string, text = "export const value = 1;\n") {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function withRepo(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "forge-repo-files-"));
  try {
    git(root, "init", "--initial-branch=main");
    write(root, ".gitignore", "src/generated/\n");
    write(root, "src/tracked.ts");
    git(root, "add", ".gitignore", "src/tracked.ts");
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("repository listing excludes an untracked transient root folder before its files disappear", () => {
  withRepo((root) => {
    const transient = mkdtempSync(join(root, ".journey-exit-"));
    writeFileSync(join(transient, "journey.mjs"), "export {};\n");
    const paths = listRepoFiles(root);
    rmSync(transient, { recursive: true, force: true });
    expect(paths).toEqual([".gitignore", "src/tracked.ts"]);
    expect(() => readRepoFiles(paths, root)).not.toThrow();
  });
}, 30_000);

test("repository listing still reads tracked sources inside otherwise transient-looking folders", () => {
  withRepo((root) => {
    const path = ".journey-exit-owned/source.ts";
    write(root, path);
    git(root, "add", path);
    const paths = listRepoFiles(root);
    expect(paths).toContain(path);
    expect(readRepoFiles(paths, root)).toContainEqual({
      path,
      text: "export const value = 1;\n",
    });
  });
}, 30_000);

test("repository listing scans new untracked sources in project roots before staging", () => {
  withRepo((root) => {
    for (const path of ["src/new-feature/nested/new.ts", "new.ts"]) {
      write(root, path);
      const paths = listRepoFiles(root);
      expect(paths).toContain(path);
      expect(readRepoFiles(paths, root)).toContainEqual({
        path,
        text: "export const value = 1;\n",
      });
    }
  });
}, 30_000);

test("repository listing respects ignored untracked files but still scans force-added files", () => {
  withRepo((root) => {
    write(root, "src/generated/ignored.ts");
    write(root, "src/generated/tracked.ts");
    git(root, "add", "--force", "src/generated/tracked.ts");
    expect(listRepoFiles(root)).toEqual([
      ".gitignore",
      "src/generated/tracked.ts",
      "src/tracked.ts",
    ]);
  });
}, 30_000);

test("a missing tracked source remains listed and fails when guards read it", () => {
  withRepo((root) => {
    rmSync(join(root, "src/tracked.ts"));
    const paths = listRepoFiles(root);
    expect(paths).toContain("src/tracked.ts");
    expect(() => readRepoFiles(paths, root)).toThrow("ENOENT");
  });
}, 30_000);
