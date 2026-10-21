import type { SourceFile, Violation } from "./repo.ts";
import { maskLiterals } from "./timeouts.ts";

/**
 * Integration tests run in parallel workers that all execute the one built `dist/`, so no
 * test may rebuild it or write under it: a test that needs a changed artifact mutates its
 * own copy in a temp folder.
 */

const ROOT_ANCHOR = /\bimport\.meta\b|\b__dirname\b|\brepoRoot\b/;
const DIST_LITERAL = /["'`](?:\.\.?\/)*dist(?:[/"'`])/;
const CONST_INIT = /\b(?:const|let|var)\s+(\w+)\s*=([^;]*);/g;
const WRITES =
  /(?<![\w$.])(?:fs\.)?(writeFileSync|appendFileSync|rmSync|unlinkSync|mkdirSync|truncateSync|writeFile|appendFile|rm|unlink|mkdir|cpSync|copyFileSync|renameSync|symlinkSync|cp|copyFile|rename)\s*\(/g;
/** These take the written path second; every other write takes it first. */
const DESTINATION_SECOND = new Set([
  "cpSync",
  "copyFileSync",
  "renameSync",
  "symlinkSync",
  "cp",
  "copyFile",
  "rename",
]);
const REBUILD = /\[\s*["']run["']\s*,\s*["']build["']/g;

const mentions = (text: string, names: ReadonlySet<string>): boolean =>
  [...names].some((name) =>
    new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(text),
  );

function argumentsAt(masked: string, open: number): [number, number][] {
  const spans: [number, number][] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) {
        spans.push([start, i]);
        return spans;
      }
    } else if (ch === "," && depth === 1) {
      spans.push([start, i]);
      start = i + 1;
    }
  }
  return spans;
}

export function findSharedDistWrites(
  files: readonly SourceFile[],
): Violation[] {
  return files.flatMap(({ path, text }) => {
    const masked = maskLiterals(text);
    const roots = new Set<string>();
    const dist = new Set<string>();
    const isDist = (from: number, to: number): boolean => {
      const code = masked.slice(from, to);
      return (
        mentions(code, dist) ||
        (DIST_LITERAL.test(text.slice(from, to)) &&
          (ROOT_ANCHOR.test(code) || mentions(code, roots)))
      );
    };
    for (let grew = true; grew;) {
      grew = false;
      for (const match of masked.matchAll(CONST_INIT)) {
        const name = match[1]!;
        const from = match.index + match[0].indexOf("=") + 1;
        const to = match.index + match[0].length;
        const code = masked.slice(from, to);
        if (
          !roots.has(name) &&
          ROOT_ANCHOR.test(code) &&
          !DIST_LITERAL.test(text.slice(from, to))
        ) {
          roots.add(name);
          grew = true;
        }
        if (!dist.has(name) && isDist(from, to)) {
          dist.add(name);
          grew = true;
        }
      }
    }
    const line = (index: number): number =>
      text.slice(0, index).split("\n").length;
    const writes = [...masked.matchAll(WRITES)].flatMap((match) => {
      const spans = argumentsAt(masked, match.index + match[0].length - 1);
      const target = spans[DESTINATION_SECOND.has(match[1]!) ? 1 : 0];
      return target && isDist(...target)
        ? [
            {
              rule: "shared-dist-write",
              file: path,
              line: line(match.index),
              message: `${match[1]} writes under the shared dist/; mutate a copy in a temp folder instead`,
            },
          ]
        : [];
    });
    const rebuilds = [...text.matchAll(REBUILD)]
      .filter((match) => masked[match.index] === "[")
      .map((match) => ({
        rule: "shared-dist-write",
        file: path,
        line: line(match.index),
        message:
          "a test must not rebuild dist/; the integration lane builds once before any worker starts",
      }));
    return [...writes, ...rebuilds];
  });
}
