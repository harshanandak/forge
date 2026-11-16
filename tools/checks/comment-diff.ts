import { execFileSync } from "node:child_process";
import { gitExecutable } from "../git-executable.ts";

export interface CommentSnapshot {
  readonly head: string;
  readonly files: ReadonlyMap<
    string,
    { readonly text: string; readonly added: ReadonlySet<number> }
  >;
  currentHead(): string;
}
export function commentDiff(
  root: string,
  baseRef: string,
  roots: readonly string[] = ["."],
): CommentSnapshot {
  const executable = gitExecutable();
  const git = (...args: string[]): string =>
    execFileSync(executable, ["--literal-pathspecs", ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      stdio: "pipe",
    });
  const currentHead = (): string =>
    git("rev-parse", "--verify", "HEAD^{commit}").trim();
  const head = currentHead();
  const base = git(
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${baseRef}^{commit}`,
  ).trim();
  const mergeBase = git("merge-base", base, head).trim();
  const covered = (file: string): boolean =>
    /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(file) &&
    roots.some(
      (root) => root === "." || file.startsWith(`${root.replace(/\/$/, "")}/`),
    );
  const names = git(
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--name-status",
    "-z",
    "-M",
    "--diff-filter=ACMR",
    mergeBase,
    head,
  ).split("\0");
  const files = new Map<string, { text: string; added: ReadonlySet<number> }>();
  while (names[0]) {
    const status = names.shift()!;
    const previous = names.shift();
    const file = /^[RC]/.test(status) ? names.shift() : previous;
    if (!file || !previous) throw new Error("Incomplete changed-file list");
    if (!covered(file)) continue;
    const text = git("show", "--no-textconv", `${head}:${file}`);
    const added = new Set<number>();
    if (
      /^[AC]/.test(status) ||
      (status.startsWith("R") && !covered(previous))
    ) {
      for (let line = 1; line <= text.split("\n").length; line++)
        added.add(line);
    } else {
      const diff = git(
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--text",
        "-M",
        "-U0",
        `${mergeBase}:${previous}`,
        `${head}:${file}`,
      );
      for (const hunk of diff.matchAll(
        /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm,
      )) {
        const start = Number(hunk[1]),
          count = Number(hunk[2] ?? 1);
        for (let line = start; line < start + count; line++) added.add(line);
      }
    }
    files.set(file, { text, added });
  }
  return { head, files, currentHead };
}
