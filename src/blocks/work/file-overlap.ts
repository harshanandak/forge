import { normalizeFileDeclarations } from "./file-declarations.ts";

type Declarations = {
  expectedFiles?: readonly string[];
  actualFiles?: readonly string[];
  filesAt?: string;
};

export type GeneratedFileRule = {
  glob: string;
  regenerate: { argv: readonly string[] };
};

type Side = "left" | "right";
type IncompleteReason =
  | { kind: "tracked-paths-truncated" }
  | { kind: "undeclared" | "invalid-declarations"; side: Side }
  | { kind: "unmatched-pattern"; side: Side; pattern: string };

type Overlap = { path: string; leftPattern: string; rightPattern: string };

const wildcard = /[*?]/u;

function patternMatcher(pattern: string): (path: string) => boolean {
  if (!wildcard.test(pattern)) return (path) => path === pattern;
  const tokens = pattern.match(/(?<![^/])\*\*\/|\*\*|[*?]|[^*?]+/gu)!;
  const first = tokens[0];
  const last = tokens[tokens.length - 1]!;
  return (path) => {
    if (!wildcard.test(first) && !path.startsWith(first)) return false;
    if (!wildcard.test(last) && !path.endsWith(last)) return false;
    let reachable = new Uint8Array(path.length + 1);
    let next = new Uint8Array(path.length + 1);
    reachable[0] = 1;
    for (const token of tokens) {
      let directory = false;
      next.fill(0);
      for (let i = 0; i <= path.length; i++) {
        if (token === "**/") {
          directory ||= reachable[i] === 1;
          if (reachable[i] || (directory && path[i - 1] === "/")) next[i] = 1;
          continue;
        }
        const width = (path.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
        if (token === "*" || token === "**") {
          if (reachable[i]) next[i] = 1;
          if (next[i] && i < path.length && (token === "**" || path[i] !== "/"))
            next[i + width] = 1;
        } else if (reachable[i]) {
          if (token === "?") {
            if (i < path.length && path[i] !== "/") next[i + width] = 1;
          } else if (path.startsWith(token, i)) next[i + token.length] = 1;
        }
      }
      [reachable, next] = [next, reachable];
    }
    return reachable[path.length] === 1;
  };
}

function readDeclarations(
  { expectedFiles, actualFiles }: Declarations,
  side: Side,
  reasons: IncompleteReason[],
): Declarations {
  const result = normalizeFileDeclarations({ expectedFiles, actualFiles }, [
    "expectedFiles",
    "actualFiles",
  ]);
  if (!result.ok) {
    reasons.push({ kind: "invalid-declarations", side });
    return {};
  }
  if (result.patch.expectedFiles === undefined)
    reasons.push({ kind: "undeclared", side });
  return result.patch;
}

function resolvePatterns(
  { expectedFiles = [], actualFiles = [] }: Declarations,
  paths: ReadonlySet<string>,
  side: Side,
  reasons: IncompleteReason[],
): Map<string, string> {
  const matches = new Map(actualFiles.map((path) => [path, path]));
  for (const pattern of new Set(expectedFiles)) {
    if (!wildcard.test(pattern)) {
      matches.set(pattern, pattern);
      continue;
    }
    const match = patternMatcher(pattern);
    let found = false;
    for (const path of paths) {
      if (!match(path)) continue;
      found = true;
      if (!matches.has(path)) matches.set(path, pattern);
    }
    if (!found) reasons.push({ kind: "unmatched-pattern", side, pattern });
  }
  return matches;
}

export function resolveFileOverlap(input: {
  left: Declarations;
  right: Declarations;
  trackedPaths: readonly string[];
  trackedPathsTruncated?: boolean;
  generatedFiles?: readonly GeneratedFileRule[];
}): {
  complete: boolean;
  reasons: IncompleteReason[];
  overlaps: Overlap[];
  generated: (Overlap & { rule: GeneratedFileRule })[];
} {
  const reasons: IncompleteReason[] = [];
  if (input.trackedPathsTruncated)
    reasons.push({ kind: "tracked-paths-truncated" });
  const left = readDeclarations(input.left, "left", reasons);
  const right = readDeclarations(input.right, "right", reasons);
  const paths = new Set(input.trackedPaths);
  for (const { expectedFiles = [], actualFiles = [] } of [left, right]) {
    for (const path of actualFiles) paths.add(path);
    for (const pattern of expectedFiles)
      if (!wildcard.test(pattern)) paths.add(pattern);
  }
  const leftMatches = resolvePatterns(left, paths, "left", reasons);
  const rightMatches = resolvePatterns(right, paths, "right", reasons);
  const rules = (input.generatedFiles ?? []).map((rule) => ({
    rule,
    matches: patternMatcher(rule.glob),
  }));
  const overlaps: Overlap[] = [];
  const generated: (Overlap & { rule: GeneratedFileRule })[] = [];
  for (const path of [...leftMatches.keys()].sort()) {
    const rightPattern = rightMatches.get(path);
    if (rightPattern === undefined) continue;
    const overlap = { path, leftPattern: leftMatches.get(path)!, rightPattern };
    const exclusion = rules.find((rule) => rule.matches(path));
    if (exclusion) generated.push({ ...overlap, rule: exclusion.rule });
    else overlaps.push(overlap);
  }
  return { complete: reasons.length === 0, reasons, overlaps, generated };
}
