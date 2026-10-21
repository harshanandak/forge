import type { SourceFile, Violation } from "./repo.ts";
import { maskLiterals } from "./timeouts.ts";

/**
 * A test never decides to skip from whether a build exists or whether it runs in CI: the
 * integration lane builds first, so a missing `dist/` must fail the run, not pass it empty.
 */

const BUILD_PROBE = /\bexistsSync\s*\(|\bprocess\.env\.CI\b/;
const CONST_INIT = /\b(?:const|let|var)\s+(\w+)\s*=([^;]*);/g;
const SKIP_IF = /(?<![\w$])(?:test|it|describe)\.skipIf\s*\(/g;
const SKIP_REF = /(?<![\w$])(?:test|it|describe)\.skip\b(?!If)/g;

function probes(text: string, tainted: ReadonlySet<string>): boolean {
  if (BUILD_PROBE.test(text)) return true;
  for (const name of tainted)
    if (new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(text)) return true;
  return false;
}

function argument(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    if (text[i] === ")" && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

function statement(text: string, at: number): string {
  const start = Math.max(
    text.lastIndexOf(";", at),
    text.lastIndexOf("{", at),
    text.lastIndexOf("}", at),
  );
  const end = text.indexOf(";", at);
  return text.slice(start + 1, end === -1 ? text.length : end);
}

export function findBuildDependentSkips(
  files: readonly SourceFile[],
): Violation[] {
  return files.flatMap(({ path, text }) => {
    const masked = maskLiterals(text);
    const tainted = new Set<string>();
    for (let grew = true; grew; ) {
      grew = false;
      for (const [, name, init] of masked.matchAll(CONST_INIT))
        if (
          name !== undefined &&
          init !== undefined &&
          !tainted.has(name) &&
          probes(init, tainted)
        ) {
          tainted.add(name);
          grew = true;
        }
    }
    const sites = [
      ...[...masked.matchAll(SKIP_IF)].map((m) => ({
        index: m.index,
        condition: argument(masked, m.index + m[0].length - 1),
      })),
      ...[...masked.matchAll(SKIP_REF)].map((m) => ({
        index: m.index,
        condition: statement(masked, m.index),
      })),
    ];
    return sites
      .filter(({ condition }) => probes(condition, tainted))
      .map(({ index }) => ({
        rule: "build-dependent-skip",
        file: path,
        line: text.slice(0, index).split("\n").length,
        message:
          "a test must not skip on a missing build or on CI; the integration lane builds first, so fail instead",
      }));
  });
}

/** The integration lane builds before Bun discovers any test, so no worker starts without `dist/`. */
export function findUnbuiltIntegrationLane(
  scripts: Readonly<Record<string, string>>,
): Violation[] {
  const lane = scripts["test:integration"] ?? "";
  return /^bun run build && bun test\b/.test(lane)
    ? []
    : [
        {
          rule: "integration-builds-first",
          file: "package.json",
          message:
            'scripts["test:integration"] must start with "bun run build && bun test"',
        },
      ];
}
