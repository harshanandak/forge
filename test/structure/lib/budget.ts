import type { SourceFile, Violation } from "./repo.ts";

/**
 * Documents agents read carry a byte cap in `test/structure/budget.json` (keys are repo paths; keys
 * starting with `_` are comments). A file over its cap, or a capped file that is missing, fails.
 */

export const BUDGET_PATH = "test/structure/budget.json";

export function parseBudget(raw: unknown): Map<string, number> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${BUDGET_PATH} must be a JSON object of path to byte cap`);
  }
  const caps = new Map<string, number>();
  for (const [path, cap] of Object.entries(raw)) {
    if (path.startsWith("_")) continue;
    if (typeof cap !== "number" || !Number.isInteger(cap) || cap <= 0) {
      throw new Error(
        `${BUDGET_PATH}: cap for ${path} must be a positive integer`,
      );
    }
    caps.set(path, cap);
  }
  return caps;
}

export function findOverBudget(
  files: readonly SourceFile[],
  caps: ReadonlyMap<string, number>,
): Violation[] {
  const violations: Violation[] = [];
  const byPath = new Map(files.map((f) => [f.path, f]));
  for (const [path, cap] of caps) {
    const file = byPath.get(path);
    if (file === undefined) {
      violations.push({
        rule: "budget",
        file: path,
        message: `capped in ${BUDGET_PATH} but not found; remove the entry or restore the file`,
      });
      continue;
    }
    const size = Buffer.byteLength(file.text, "utf8");
    if (size > cap) {
      violations.push({
        rule: "budget",
        file: path,
        message: `is ${size} bytes, over its ${cap}-byte cap; prune it, or raise the cap deliberately in ${BUDGET_PATH}`,
      });
    }
  }
  return violations;
}
