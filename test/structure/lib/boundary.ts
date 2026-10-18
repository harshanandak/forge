import type { SourceFile, Violation } from "./repo.ts";
import { findWords } from "./words.ts";

/** Core areas: what every solution needs and no block may own. They know no workflow. */
export const CORE_PREFIXES: readonly string[] = [
  "src/core/",
  "src/surface/",
  "src/ports/",
  "src/contract/",
  "src/generated/",
  "schemas/",
];

/** Workflow concepts core must never name: stages, TDD, pull requests, issues, workflows, delivery. */
export const BOUNDARY_TERMS: ReadonlySet<string> = new Set([
  "stage",
  "stages",
  "tdd",
  "pr",
  "prs",
  "issue",
  "issues",
  "workflow",
  "workflows",
  "delivery",
]);

export const BOUNDARY_PHRASES: ReadonlyMap<string, string> = new Map([
  ["pull request", "pull request"],
  ["pull requests", "pull request"],
  ["test driven", "test-driven"],
  ["red green", "red-green"],
]);

export function isCoreFile(path: string): boolean {
  return CORE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export function findBoundaryViolations(
  files: readonly SourceFile[],
): Violation[] {
  return findWords(
    files.filter((file) => isCoreFile(file.path)),
    BOUNDARY_TERMS,
    BOUNDARY_PHRASES,
    "boundary-words",
    (term) =>
      `core names the workflow concept "${term}"; core knows no workflow, so move this to a block or template`,
  );
}
