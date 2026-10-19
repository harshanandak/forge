import entry from "./entry.cts";
import type { CheckConfig } from "./types.ts";

/** Reusable cross-field validation with no service or context access. */
export function validateBudgets(config: CheckConfig): {
  readonly totalBytes: number;
  readonly declarationBytes: number;
} {
  return (
    entry as unknown as { validateBudgets: typeof validateBudgets }
  ).validateBudgets(config);
}
