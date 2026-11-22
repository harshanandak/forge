import { ForgeFailure } from "../../src/contract/failure.ts";
import type { RetryPosture } from "../../src/generated/types.ts";

const unavailable = (retry: RetryPosture) =>
  new ForgeFailure({
    code: "UNAVAILABLE",
    message: "Project temporarily unavailable",
    retry,
  });

export function storageFailure(error: unknown, reconcile = false) {
  if (error instanceof ForgeFailure)
    return error.error.code === "QUOTA_EXHAUSTED" ||
      error.error.code === "STORAGE_LIMIT_EXCEEDED"
      ? error
      : undefined;
  if (!(error instanceof Error)) return;
  if (
    /^Exceeded allowed rows (?:written|read) in Durable Objects free tier\.?$/.test(
      error.message,
    )
  )
    return new ForgeFailure({
      code: "QUOTA_EXHAUSTED",
      message: "Durable Object daily quota exhausted; retry after 00:00 UTC",
      retry: "safe",
    });
  if (/\bSQLITE_(?:FULL|TOOBIG)\b/.test(error.message))
    return new ForgeFailure({
      code: "STORAGE_LIMIT_EXCEEDED",
      message: "Project storage limit exceeded",
      retry: "never",
    });
  if ("retryable" in error && error.retryable === true)
    return unavailable(reconcile ? "reconcile_first" : "safe");
}

export function storageResponse(
  error: unknown,
  typed = false,
  retry?: RetryPosture,
): Response | undefined {
  const failure =
    storageFailure(error, retry === "reconcile_first") ??
    (retry && unavailable(retry));
  if (failure)
    return Response.json(
      {
        ok: false,
        ...(typed ? { status: "FAIL", warnings: [] } : {}),
        error: failure.error,
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
}
