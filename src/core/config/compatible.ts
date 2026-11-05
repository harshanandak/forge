import { nameDistance } from "../../contract/distance.ts";
import type { SchemaProblem } from "../../contract/schema.ts";
import { clone, parsePointer } from "./pointer.ts";

/** Ignore newer config keys in memory, preserving the file and every other schema refusal. */
export function compatibleConfig<T>(
  name: string,
  config: T,
  problems: readonly SchemaProblem[],
  warn?: (name: string, paths: readonly string[]) => void,
): { config: T; problems: readonly SchemaProblem[] } {
  const sanitized = clone(config);
  const paths: string[] = [];
  const remaining = problems.flatMap((problem) => {
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
    let parent: unknown = sanitized;
    for (const part of parts.slice(0, -1)) {
      // Array items are schema-defined records, not extensible config option objects.
      if (
        typeof parent !== "object" ||
        parent === null ||
        Array.isArray(parent)
      )
        return [problem];
      parent = (parent as Record<string, unknown>)[part];
    }
    if (typeof parent !== "object" || parent === null) return [problem];
    delete (parent as Record<string, unknown>)[key];
    paths.push(`blocks.${name}.config.${parts.join(".")}`);
    return [];
  });
  if (paths.length) warn?.(name, paths);
  return { config: sanitized, problems: remaining };
}
