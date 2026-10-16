import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Violation {
  readonly rule: string;
  readonly file: string;
  readonly line?: number;
  readonly message: string;
}

export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

export const repoRoot: string = fileURLToPath(
  new URL("../../../", import.meta.url),
);

export function format(violations: readonly Violation[]): string[] {
  return violations.map(
    (v) =>
      `[${v.rule}] ${v.file}${v.line === undefined ? "" : `:${v.line}`} ${v.message}`,
  );
}

/** Every file that is tracked or untracked-but-not-ignored, so a planted file is seen before it is committed. */
export function listRepoFiles(root: string = repoRoot): string[] {
  const out = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (out.status !== 0) {
    throw new Error(
      `git ls-files failed in ${root}: ${out.stderr || out.error?.message}`,
    );
  }
  return [...new Set(out.stdout.split("\0").filter((p) => p !== ""))]
    .filter((p) => existsSync(join(root, p)))
    .sort();
}

/** Read a file as text; returns undefined for binary files. */
export function readTextFile(
  path: string,
  root: string = repoRoot,
): string | undefined {
  const buffer = readFileSync(join(root, path));
  if (buffer.subarray(0, 8000).includes(0)) return undefined;
  return buffer.toString("utf8");
}

export function readRepoFiles(
  paths: readonly string[],
  root: string = repoRoot,
): SourceFile[] {
  const files: SourceFile[] = [];
  for (const path of paths) {
    const text = readTextFile(path, root);
    if (text !== undefined) files.push({ path, text });
  }
  return files;
}

export const CODE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
export const TEST_FILE = /(?:\.|_)(?:test|spec)\.[cm]?[jt]sx?$/;

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path) || /(?:^|\/)test\//.test(path);
}

export function readJson(path: string, root: string = repoRoot): unknown {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}
