// Effect outcomes and retry. A request ID identifies a request for replay; it is never permission to
// retry. An effect that is uncertain, or declared and never reported, must be reconciled through the
// owning block's read operation before anything is retried.
import type {
  EffectName,
  ExecutionObservation,
  ForgeError,
} from "../generated/types.ts";

export type RetryDecision =
  | { readonly retry: true; readonly reason: "nothing_applied" }
  | {
      readonly retry: false;
      readonly reason: "completed" | "applied" | "uncertain";
      readonly error?: ForgeError;
    };

export function retryDecision(
  declaredEffects: readonly EffectName[],
  observation: ExecutionObservation,
): RetryDecision {
  const reported = new Map(observation.effects.map((e) => [e.effect, e]));
  const unreported = declaredEffects.filter((effect) => !reported.has(effect));
  const uncertain = observation.effects.filter(
    (e) => e.outcome === "uncertain",
  );
  if (uncertain.length > 0 || unreported.length > 0) {
    const names = [...uncertain.map((e) => e.effect), ...unreported];
    const reconcileWith = uncertain.find((e) => e.reconcileWith)?.reconcileWith;
    return {
      retry: false,
      reason: "uncertain",
      error: {
        code: "EFFECT_UNCERTAIN",
        message: `the outcome of ${names.join(", ")} is not known; read the current state before deciding to repeat ${observation.op}`,
        retry: "reconcile_first",
        ...(reconcileWith === undefined ? {} : { reconcileWith }),
      },
    };
  }
  if (observation.status === "completed")
    return { retry: false, reason: "completed" };
  if (observation.effects.some((e) => e.outcome === "applied")) {
    return { retry: false, reason: "applied" };
  }
  return { retry: true, reason: "nothing_applied" };
}
