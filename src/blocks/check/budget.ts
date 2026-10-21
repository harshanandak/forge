import entry from "./entry.cts";
import type { CheckConfig, RunInput } from "./types.ts";

/** One selected-run resolver for receipt and operation budgets. */
export function runTimeoutMs(config: CheckConfig, input: RunInput): number {
  return (
    entry as unknown as { runTimeoutMs: typeof runTimeoutMs }
  ).runTimeoutMs(config, input);
}

/** Reusable cross-field validation with no service or context access. */
export function validateBudgets(config: CheckConfig): {
  readonly totalBytes: number;
  readonly declarationBytes: number;
} {
  return (
    entry as unknown as { validateBudgets: typeof validateBudgets }
  ).validateBudgets(config);
}
