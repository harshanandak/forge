import { ProcessSpawnError } from "./errors.ts";

export interface SupervisionOptions {
  readonly cleanupTimeoutMs: number;
  readonly pollIntervalMs: number;
  readonly drainTimeoutMs: number;
  readonly maxConcurrent: number;
}

/** Safety ceilings bound temporary helpers and cleanup even for malformed host config. */
export const MAX_SUPERVISORS: number = 1;

export function validateSupervision(
  value: SupervisionOptions | undefined,
): SupervisionOptions {
  const bounded = (entry: number, maximum: number, minimum = 1): boolean =>
    Number.isSafeInteger(entry) && entry >= minimum && entry <= maximum;
  if (
    !value ||
    !bounded(value.cleanupTimeoutMs, 60_000) ||
    !bounded(value.pollIntervalMs, 1000) ||
    value.pollIntervalMs > value.cleanupTimeoutMs ||
    !bounded(value.drainTimeoutMs, 60_000, 0) ||
    !bounded(value.maxConcurrent, MAX_SUPERVISORS, 0)
  )
    throw new ProcessSpawnError(
      "INVALID_OPTIONS",
      "Declare supervision cleanupTimeoutMs (1..60000), pollIntervalMs (1..1000, no greater than cleanup), drainTimeoutMs (0..60000), and maxConcurrent (0..1)",
    );
  return Object.freeze({ ...value });
}
