import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

function gitFiles(root: string, flags: readonly string[]): string[] {
  const out = spawnSync("git", ["ls-files", "-z", ...flags], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (out.status !== 0) {
    throw new Error(
      `git ls-files failed in ${root}: ${out.stderr || out.error?.message}`,
    );
  }
  return out.stdout.split("\0").filter((path) => path !== "");
}

/**
 * Keep every tracked path, even if missing. Include nonignored untracked root files and files
 * under every ordinary root directory, including brand-new source roots. Only a root dot
 * directory with no tracked contents is treated as scratch space (such as .journey-exit-*).
 * Stage hidden source roots to scan them; existing dot roots such as
 * .github keep their untracked files visible. Nested dot directories are not excluded.
 */
export function listRepoFiles(root: string = repoRoot): string[] {
  const tracked = gitFiles(root, ["--cached"]);
  const trackedRoots = new Set(
    tracked
      .filter((path) => path.includes("/"))
      .map((path) => path.split("/")[0]!),
  );
  const untracked = gitFiles(root, ["--others", "--exclude-standard"]).filter(
    (path) => !/^\.[^/]+\//.test(path) || trackedRoots.has(path.split("/")[0]!),
  );
  return [...new Set([...tracked, ...untracked])].sort();
}

/** Copy listed files only; never walk directories that may contain another test's scratch files. */
export function copyRepoFiles(
  paths: readonly string[],
  destination: string,
  root: string = repoRoot,
): void {
  for (const path of paths) {
    const target = join(destination, path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(root, path), target);
  }
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

/**
 * Detector modules of the project block: the only shipped files outside adapters that may name a
 * package manager, runner or hook runner (to recognise it) or a retired name. A detector is a file
 * `src/blocks/project/detect-<name>.ts`; everything else in that folder is ordinary shipped code.
 */
export const DETECTOR_MODULE = /^src\/blocks\/project\/detect-[^/]+\.ts$/;

export const CODE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
export const TEST_FILE = /(?:\.|_)(?:test|spec)\.[cm]?[jt]sx?$/;

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path) || /(?:^|\/)test\//.test(path);
}

export function readJson(path: string, root: string = repoRoot): unknown {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}
