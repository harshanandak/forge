import { nameDistance } from "../../contract/distance.ts";
import type { SchemaProblem } from "../../contract/schema.ts";
import { parsePointer } from "./pointer.ts";

/** Ignore newer config keys in memory, preserving the file and every other schema refusal. */
export function compatibleConfigProblems(
  name: string,
  config: unknown,
  problems: readonly SchemaProblem[],
  warn?: (message: string) => void,
): readonly SchemaProblem[] {
  return problems.flatMap((problem) => {
    const parts = parsePointer(problem.pointer) ?? [];
    const key = parts.at(-1);
    if (
      problem.keyword !== "additionalProperties" ||
      key === undefined ||
      problem.knownProperties === undefined
    )
      return [problem];
    const caseMatch = problem.knownProperties.find(
      (known) => known.toLowerCase() === key.toLowerCase(),
    );
    if (caseMatch !== undefined) return [{ ...problem, suggestion: caseMatch }];
    if (
      problem.knownProperties.some((known) => nameDistance(key, known, 1) <= 1)
    )
      return [problem];
    let parent = config;
    for (const part of parts.slice(0, -1)) {
      if (typeof parent !== "object" || parent === null) return [problem];
      parent = (parent as Record<string, unknown>)[part];
    }
    if (typeof parent !== "object" || parent === null) return [problem];
    delete (parent as Record<string, unknown>)[key];
    warn?.(
      `.forge/config.yaml: blocks.${name}.config.${parts.join(".")}: unknown property "${key}" may come from a newer Forge version; upgrade to use it. It is ignored by this version.`,
    );
    return [];
  });
}
