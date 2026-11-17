import { ForgeFailure } from "../../src/contract/failure.ts";

export function storageFailure(error: unknown): ForgeFailure | undefined {
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
}

export function storageResponse(
  error: unknown,
  typed = false,
): Response | undefined {
  const failure = storageFailure(error);
  if (failure)
    return Response.json(
      {
        ok: false,
        ...(typed ? { status: "FAIL", warnings: [] } : {}),
        error: failure.error,
      },
      { status: 503 },
    );
}
