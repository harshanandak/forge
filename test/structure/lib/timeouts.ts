import type { SourceFile, Violation } from "./repo.ts";
import { TEST_FILE } from "./repo.ts";

/**
 * Every test declares an explicit timeout: a third argument on the call (a number or a `{ timeout }`
 * options object), or a top-level `setDefaultTimeout(<number>)` earlier in the file. A configured
 * default is not enough, because the bunfig `timeout` was silently ignored in the past.
 */

const FILE_DEFAULT = /^[ \t]*setDefaultTimeout\(\s*\d[\d_]*\s*\)/m;
const TEST_CALL = /(?<![\w.$])(?:test|it)((?:\.\w+)*)\s*\(/g;

function blank(text: string, from: number, to: number): string {
  return text.slice(from, to).replace(/[^\n]/g, " ");
}

/** Index just past the template literal whose opening backtick is at `start`. */
function templateEnd(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length && text[i] !== "`") {
    if (text[i] === "\\") {
      i += 2;
    } else if (text[i] === "$" && text[i + 1] === "{") {
      let depth = 0;
      for (; i < text.length; i += 1) {
        if (text[i] === "{") depth += 1;
        if (text[i] === "}" && --depth === 0) break;
      }
      i += 1;
    } else {
      i += 1;
    }
  }
  return i + 1;
}

/** Same text with comment and string contents blanked, so scanning sees only code. */
export function maskLiterals(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    let end = i;
    if (ch === "/" && next === "/") {
      end = text.indexOf("\n", i);
      if (end === -1) end = text.length;
    } else if (ch === "/" && next === "*") {
      const close = text.indexOf("*/", i + 2);
      end = close === -1 ? text.length : close + 2;
    } else if (ch === '"' || ch === "'") {
      end = i + 1;
      while (end < text.length && text[end] !== ch && text[end] !== "\n") {
        end += text[end] === "\\" ? 2 : 1;
      }
      end += 1;
    } else if (ch === "`") {
      end = templateEnd(text, i);
    }
    if (end > i) {
      out += blank(text, i, Math.min(end, text.length));
      i = end;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

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
      if (modifiers.includes("each")) {
        // test.each(table)(name, fn, timeout): the call is the second parenthesised group
        const table = callArguments(code, open);
        const next = /^\s*\(/.exec(code.slice(table.end));
        if (next === null) continue;
        open = table.end + next[0].length - 1;
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
