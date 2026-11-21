import { maskLiterals } from "../../../tools/ci/source-scan.ts";
import type { SourceFile, Violation } from "./repo.ts";
import { TEST_FILE } from "./repo.ts";

export { maskLiterals };

/**
 * Every test declares an explicit timeout: a third argument on the call (a number or a `{ timeout }`
 * options object), or a top-level `setDefaultTimeout(<number>)` earlier in the file. A configured
 * default is not enough, because the bunfig `timeout` was silently ignored in the past.
 */

const FILE_DEFAULT = /^[ \t]*setDefaultTimeout\(\s*\d[\d_]*\s*\)/m;
/** Modifiers that return the real test function: `test.each(table)(name, fn, timeout)`, `test.skipIf(cond)(...)`. */
const CURRIED = ["each", "skipIf", "if", "todoIf"];
const TEST_CALL = /(?<![\w.$])(?:test|it)((?:\.\w+)*)\s*\(/g;

/** Arguments of the call whose opening bracket is at `open`, split on top-level commas. */
function callArguments(
  code: string,
  open: number,
): { args: string[]; end: number } {
  const args: string[] = [];
  let depth = 0;
  let argStart = open + 1;
  for (let i = open; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) {
        args.push(code.slice(argStart, i));
        return { args, end: i + 1 };
      }
    } else if (ch === "," && depth === 1) {
      args.push(code.slice(argStart, i));
      argStart = i + 1;
    }
  }
  return { args, end: code.length };
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

export function findMissingTimeouts(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    if (!TEST_FILE.test(file.path)) continue;
    const code = maskLiterals(file.text);
    const defaultAt =
      FILE_DEFAULT.exec(code)?.index ?? Number.POSITIVE_INFINITY;
    for (const match of code.matchAll(TEST_CALL)) {
      const start = match.index;
      const modifiers = (match[1] ?? "").split(".").filter(Boolean);
      if (
        modifiers.includes("skip") ||
        modifiers.includes("todo") ||
        start > defaultAt
      )
        continue;
      let open = start + match[0].length - 1;
      if (modifiers.some((m) => CURRIED.includes(m))) {
        // test.each(table)(name, fn, timeout): the call is the second parenthesised group
        const first = callArguments(code, open);
        const next = /^\s*\(/.exec(code.slice(first.end));
        if (next === null) continue;
        open = first.end + next[0].length - 1;
      }
      const timeout = callArguments(code, open).args[2]?.trim();
      if (timeout === undefined || timeout === "") {
        violations.push({
          rule: "test-timeouts",
          file: file.path,
          line: lineOf(code, start),
          message:
            "test declares no explicit timeout; pass one as the third argument or call setDefaultTimeout(<ms>) at the top of the file",
        });
      }
    }
  }
  return violations;
}
