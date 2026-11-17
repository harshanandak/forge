import { isObject } from "../../src/core/config/pointer.ts";
import type { Table } from "./digest.ts";

export interface ComparisonProblem {
  table: Table;
  key: string[];
  reason: string;
}
export class ComparisonCheckFailure extends Error {
  readonly problem: ComparisonProblem;
  constructor(problem: ComparisonProblem) {
    super(problem.reason);
    this.problem = problem;
  }
}
export function comparisonCheck(
  condition: unknown,
  table: Table,
  key: string[],
  reason: string,
): asserts condition {
  if (!condition) throw new ComparisonCheckFailure({ table, key, reason });
}
export function comparisonRecord(body: unknown, table: Table, key: string[]) {
  let value: unknown;
  try {
    value = JSON.parse(String(body));
  } catch {
    throw new ComparisonCheckFailure({
      table,
      key,
      reason: "stop metadata JSON",
    });
  }
  comparisonCheck(
    isObject(value) && isObject(value.value),
    table,
    key,
    "stop metadata shape",
  );
  return value as Record<string, unknown> & { value: Record<string, unknown> };
}
