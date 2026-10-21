import entry from "./entry.cts";
import type { CheckConfig, RunInput } from "./types.ts";
import { ForgeFailure } from "../../contract/failure.ts";

/** One selected-run resolver for receipt and operation budgets. */
export function runTimeoutMs(
  config: CheckConfig,
  input: RunInput,
  timing: { readonly cleanupMs: number; readonly snapshotMs: number },
  configPath?: string,
): number {
  return typedBudget(() =>
    (entry as unknown as { runTimeoutMs: typeof runTimeoutMs }).runTimeoutMs(
      config,
      input,
      timing,
      configPath,
    ),
  );
}

function typedBudget<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    // Outside the block VM, its fail callback is not installed.
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "INPUT_INVALID"
    )
      throw Object.assign(
        new ForgeFailure({
          code: error.code,
          message: error.message.slice(`${error.code}: `.length),
          retry: "never",
        }),
        { code: error.code },
      );
    throw error;
  }
}

/** Reusable cross-field validation with no service or context access. */
export function validateBudgets(config: CheckConfig): {
  readonly totalBytes: number;
  readonly declarationBytes: number;
} {
  return typedBudget(() =>
    (
      entry as unknown as { validateBudgets: typeof validateBudgets }
    ).validateBudgets(config),
  );
}
