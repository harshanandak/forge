import { ProcessSpawnError } from "./errors.ts";

export interface SupervisorDeadlineControl {
  now(): number;
  schedule(action: () => void, ms: number): void;
  terminate(): void;
}

/** One invocation budget covers waiting for start and the full owned helper lifetime. */
export function createSupervisorDeadline(
  budget: string | undefined,
  control: SupervisorDeadlineControl,
): { active(): boolean } {
  if (
    budget === undefined ||
    budget.length > 10 ||
    !/^[1-9]\d*$/.test(budget) ||
    !Number.isSafeInteger(Number(budget)) ||
    Number(budget) > 2147483647
  )
    throw new ProcessSpawnError(
      "INVALID_OPTIONS",
      "The supervisor needs a runtime budget from 1 to 2147483647 milliseconds",
    );
  const timeoutMs = Number(budget);
  const expires = control.now() + timeoutMs;
  let expired = false;
  const terminate = (): void => {
    if (expired) return;
    expired = true;
    control.terminate();
  };
  control.schedule(terminate, timeoutMs);
  return {
    active() {
      if (control.now() >= expires) terminate();
      return !expired;
    },
  };
}
