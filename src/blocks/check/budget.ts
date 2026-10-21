import entry from "./entry.cts";
import type { CheckConfig, RunInput } from "./types.ts";
import { ForgeFailure } from "../../contract/failure.ts";

/** One selected-run resolver for receipt and operation budgets. */
export function runTimeoutMs(config: CheckConfig, input: RunInput): number {
  try {
    return (
      entry as unknown as { runTimeoutMs: typeof runTimeoutMs }
    ).runTimeoutMs(config, input);
  } catch (error) {
    // Outside the block VM, its fail callback is not installed.
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "INPUT_INVALID"
    )
      throw new ForgeFailure({
        code: error.code,
        message: error.message.slice(`${error.code}: `.length),
        retry: "never",
      });
    throw error;
  }
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
