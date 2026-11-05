import { nameDistance } from "../../contract/distance.ts";
import type { SchemaProblem } from "../../contract/schema.ts";
import { clone, parsePointer } from "./pointer.ts";

/** Ignore newer config keys in memory, preserving the file and every other schema refusal. */
export function compatibleConfig<T>(
  name: string,
  config: T,
  problems: readonly SchemaProblem[],
  warn?: (name: string, paths: readonly string[]) => void,
  check?: (config: T) => readonly SchemaProblem[],
): { config: T; problems: readonly SchemaProblem[] } {
  if (
    check !== undefined &&
    problems.some((problem) => problem.alternatives !== undefined)
  ) {
    for (const candidate of alternativeCopies(name, config, problems)) {
      const retried = compatibleConfig(
        name,
        candidate.config,
        check(candidate.config),
        (_name, dropped) => candidate.paths.push(...dropped),
        check,
      );
      if (retried.problems.length === 0 && check(retried.config).length === 0) {
        warn?.(name, candidate.paths);
        return retried;
      }
    }
    return { config: clone(config), problems };
  }
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
    if (
      typeof parent !== "object" ||
      parent === null ||
      !Object.hasOwn(parent, key)
    )
      return [problem];
    delete (parent as Record<string, unknown>)[key];
    paths.push(`blocks.${name}.config.${parts.join(".")}`);
    return [];
  });
  if (paths.length) warn?.(name, paths);
  return { config: sanitized, problems: remaining };
}

/** Each retry must remove a key; a union's original errors survive unless the whole config validates. */
function* alternativeCopies<T>(
  name: string,
  config: T,
  problems: readonly SchemaProblem[],
): Generator<{ config: T; paths: string[] }> {
  const problem = problems.find((entry) => entry.alternatives !== undefined);
  for (const alternative of problem?.alternatives ?? []) {
    const paths: string[] = [];
    const candidate = compatibleConfig(
      name,
      config,
      alternative,
      (_name, dropped) => paths.push(...dropped),
    );
    if (paths.length) yield { config: candidate.config, paths };
    yield* alternativeCopies(name, candidate.config, candidate.problems);
  }
}
