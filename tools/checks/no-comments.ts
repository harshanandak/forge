import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { helpListsBuiltin } from "../bun-builtin.ts";
import { commentDiff } from "./comment-diff.ts";

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
  readonly lintExecutable?: string;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function checkComments(
  options: CommentCheckOptions,
): CommentCheckResult {
  try {
    const snapshot = commentDiff(options.root, options.base, options.roots);
    const executable =
      options.lintExecutable ?? process.env.FORGE_LINT_BUN ?? "bun";
    const help = spawnSync(executable, ["--help"], {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    });
    if (help.status !== 0 || !helpListsBuiltin(help.stdout, "lint"))
      throw new Error(
        "Bun lint unavailable; select a canary build with --bun or FORGE_LINT_BUN",
      );
    if (!snapshot.files.size) return { status: "PASS", violations: [] };
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const plugin = fileURLToPath(
      new URL(`../lint/no-comments.${extension}`, import.meta.url),
    );
    const result = spawnSync(
      executable,
      [
        "lint",
        "--no-script",
        "--no-config-lookup",
        "--no-inline-config",
        "--no-ignore",
        "--format",
        "json",
        "--plugin",
        plugin,
        "--rule",
        `forge/no-comments: ["error", ${JSON.stringify({ base: options.base, ...(options.roots ? { roots: options.roots } : {}) })}]`,
        "--",
        ...snapshot.files.keys(),
      ],
      {
        cwd: options.root,
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      },
    );
    if (result.error || result.status === null || result.status > 1)
      throw new Error(
        result.error?.message ?? result.stderr ?? "Bun lint failed",
      );
    const output: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(output)) throw new Error("Incomplete lint output");
    const expected = new Map(
      [...snapshot.files.keys()].map((file) => [
        resolve(options.root, file).toLowerCase(),
        file,
      ]),
    );
    const violations: CommentViolation[] = [];
    for (const item of output) {
      if (
        !record(item) ||
        typeof item.filePath !== "string" ||
        !Array.isArray(item.messages)
      )
        throw new Error("Invalid lint file result");
      const key = resolve(item.filePath).toLowerCase(),
        file = expected.get(key);
      if (!file) throw new Error("Unexpected or repeated lint file result");
      expected.delete(key);
      if (typeof item.fatalErrorCount === "number" && item.fatalErrorCount > 0)
        throw new Error(`Parsing failed: ${file}`);
      for (const message of item.messages) {
        if (!record(message) || typeof message.message !== "string")
          throw new Error("Invalid lint diagnostic");
        if (message.fatal === true) throw new Error(`Parsing failed: ${file}`);
        if (message.ruleId !== "forge/no-comments") continue;
        if (message.message.startsWith("INCOMPLETE:"))
          throw new Error(message.message);
        const found =
          /^new (line comment|block comment|JSDoc) \(Git line (\d+)\)$/.exec(
            message.message,
          );
        if (!found) throw new Error("Invalid comment diagnostic");
        violations.push({ file, line: Number(found[2]), kind: found[1]! });
      }
    }
    if (expected.size) throw new Error("Lint skipped a changed source file");
    if (snapshot.currentHead() !== snapshot.head)
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
        bun: { type: "string" },
      },
    });
    result = checkComments({
      root: process.cwd(),
      base: values.base,
      ...(values.root ? { roots: values.root } : {}),
      ...(values.bun ? { lintExecutable: values.bun } : {}),
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
