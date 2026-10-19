import type { ClockPort } from "../../ports/clock.ts";
import { refuse } from "../trust/index.ts";

/** Timer representation safety bounds, not a default operation budget. */
export const TIMEOUT_BOUNDS: {
  readonly minimum: number;
  readonly maximum: number;
} = Object.freeze({
  minimum: 1,
  maximum: 2_147_483_647,
});

export function validateTimeout(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < TIMEOUT_BOUNDS.minimum ||
    value > TIMEOUT_BOUNDS.maximum
  )
    refuse(
      "INPUT_INVALID",
      "timeoutMs must be an integer from 1 to 2147483647",
    );
}

export function invocationDeadline(
  budgets: {
    readonly declared: number | undefined;
    readonly configured: number | undefined;
    readonly host: number | undefined;
    readonly embedding: number | undefined;
  },
  clock: ClockPort,
): { readonly timeoutMs: number; remaining(): number } {
  const selected =
    budgets.configured ?? budgets.declared ?? budgets.host ?? budgets.embedding;
  if (selected === undefined)
    refuse(
      "INPUT_INVALID",
      "Operation needs a declared timeoutMs or a configured runtime budget",
    );
  const limits = [selected, budgets.host, budgets.embedding].filter(
    (value): value is number => value !== undefined,
  );
  limits.forEach(validateTimeout);
  const timeoutMs = Math.min(...limits);
  const deadline = clock.now() + timeoutMs;
  return {
    timeoutMs,
    remaining() {
      const remaining = deadline - clock.now();
      if (remaining <= 0)
        refuse("INVOCATION_TIMEOUT", "Invocation deadline exceeded");
      return Math.max(TIMEOUT_BOUNDS.minimum, Math.ceil(remaining));
    },
  };
}
