import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { sourceComments } from "../../src/adapters/source-comments/index.ts";
import { gitExecutable } from "../git-executable.ts";

export interface CommentViolation {
  readonly file: string;
  readonly line: number;
  readonly kind: string;
}
export interface CommentCheckResult {
  readonly status: "PASS" | "FAIL" | "INCOMPLETE";
  readonly violations: readonly CommentViolation[];
  readonly reason?: string;
}
export interface CommentCheckOptions {
  readonly root: string;
  readonly base: string;
  readonly roots?: readonly string[];
}
export function addedComments(
  file: string,
  text: string,
  added: ReadonlySet<number>,
): readonly CommentViolation[] {
  const violations: CommentViolation[] = [];
  for (const comment of sourceComments.comments(file, text)) {
    if (directive(comment.text.trim(), comment.kind === "line comment"))
      continue;
    for (let line = comment.startLine; line <= comment.endLine; line++) {
      if (!added.has(line)) continue;
      violations.push({ file, line, kind: comment.kind });
      break;
    }
  }
  return violations;
}
function directive(text: string, line: boolean): boolean {
  return (
    /^eslint-(?:disable(?:-next-line|-line)?|enable)(?:\s+[\w@/-]+(?:\s*,\s*[\w@/-]+)*)?(?:\s+--[^\r\n]+)?$/.test(
      text,
    ) ||
    /^@ts-expect-error(?:[ \t:][^\r\n]*)?$/.test(text) ||
    /^biome-ignore[ \t]+[\w/-]+(?:\([^()\r\n]*\))?(?:[ \t]+[\w/-]+(?:\([^()\r\n]*\))?)*[ \t]*:[ \t]+[^\r\n]+$/.test(
      text,
    ) ||
    (line &&
      /^\/[ \t]*<reference(?:[ \t]+(?:path|types|lib|no-default-lib|resolution-mode|preserve)=(?:"[^"\r\n]*"|'[^'\r\n]*'))+[ \t]*\/>$/.test(
        text,
      ))
  );
}
export function checkComments(
  options: CommentCheckOptions,
): CommentCheckResult {
  try {
    const executable = gitExecutable();
    const git = (...args: string[]): string =>
      execFileSync(executable, ["--literal-pathspecs", ...args], {
        cwd: options.root,
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        stdio: "pipe",
      });
    const head = git("rev-parse", "--verify", "HEAD^{commit}").trim();
    const base = git(
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${options.base}^{commit}`,
    ).trim();
    const mergeBase = git("merge-base", base, head).trim();
    const roots = options.roots ?? ["."];
    const covered = (file: string): boolean =>
      /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(file) &&
      roots.some(
        (root) =>
          root === "." || file.startsWith(`${root.replace(/\/$/, "")}/`),
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
    const violations: CommentViolation[] = [];
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
          mergeBase,
          head,
          "--",
          previous,
          file,
        );
        for (const hunk of diff.matchAll(
          /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm,
        )) {
          const start = Number(hunk[1]);
          const count = Number(hunk[2] ?? 1);
          for (let line = start; line < start + count; line++) added.add(line);
        }
      }
      violations.push(...addedComments(file, text, added));
    }
    if (git("rev-parse", "HEAD").trim() !== head)
      throw new Error("HEAD changed during comment check");
    return { status: violations.length ? "FAIL" : "PASS", violations };
  } catch (error) {
    return {
      status: "INCOMPLETE",
      violations: [],
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
export function main(args: string[] = process.argv.slice(2)): void {
  let result: CommentCheckResult;
  try {
    const { values } = parseArgs({
      args,
      options: {
        base: { type: "string", default: "origin/main" },
        root: { type: "string", multiple: true },
      },
    });
    result = checkComments({
      root: process.cwd(),
      base: values.base,
      ...(values.root ? { roots: values.root } : {}),
    });
  } catch (error) {
    result = { status: "INCOMPLETE", violations: [], reason: String(error) };
  }
  for (const item of result.violations)
    console.error(`${item.file}:${item.line}: new ${item.kind}`);
  console.log(JSON.stringify(result));
  process.exitCode =
    result.status === "PASS" ? 0 : result.status === "FAIL" ? 1 : 2;
}
if (import.meta.main) main();
