import entry from "./entry.cts";
import type { CheckConfig, RunInput } from "./types.ts";
import { ForgeFailure } from "../../contract/failure.ts";

/** Shared with the engine's enforced receipt publication deadline. */
export function finalizationTimeoutMs(maxReceiptBytes: number): number {
  return (
    entry as unknown as { finalizationTimeoutMs: typeof finalizationTimeoutMs }
  ).finalizationTimeoutMs(maxReceiptBytes);
}

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
export function validateBudgets(
  config: CheckConfig,
  configPath?: string,
): {
  readonly totalBytes: number;
  readonly declarationBytes: number;
} {
  return typedBudget(() =>
    (
      entry as unknown as { validateBudgets: typeof validateBudgets }
    ).validateBudgets(config, configPath),
  );
}

/** Loading validates each declaration; aggregate receipt sizing still belongs to the selected run. */
export function validateConfiguration(
  config: CheckConfig,
  configPath: string,
): void {
  const commands = Object.entries(config.commands);
  if (commands.length === 0) validateBudgets(config, configPath);
  for (const [name, command] of commands)
    validateBudgets({ ...config, commands: { [name]: command } }, configPath);
}
