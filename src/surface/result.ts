import type { FailureEnvelope, ResultEnvelope } from "../generated/types.ts";

export function failure(
  code: string,
  message: string,
  suggest: readonly string[] = [],
): FailureEnvelope {
  return {
    ok: false,
    status: "FAIL",
    error: {
      code,
      message,
      retry: "never",
      ...(suggest.length === 0 ? {} : { suggest }),
    },
    warnings: [],
  };
}

/** A single policy for CLI and hook callers; MCP carries the same envelope unchanged. */
export function exitCode(result: ResultEnvelope): number {
  if (result.ok) return 0;
  if (result.status === "INCOMPLETE") return 2;
  switch (result.error.code) {
    case "UNKNOWN_COMMAND":
    case "NOT_FOUND":
      return 3;
    case "INPUT_CONFLICT":
    case "REVISION_CONFLICT":
    case "LEASE_HELD":
    case "LEASE_STALE":
    case "LEASE_NOT_HELD":
    case "LEASE_EXPIRED":
      return 4;
    case "INPUT_INVALID":
    case "CONTEXT_MISSING":
      return 6;
    default:
      return 1;
  }
}

export function renderText(value: unknown, depth = 0): string {
  if (value === null || typeof value !== "object") return String(value);
  const indent = "  ".repeat(depth);
  return Object.entries(value)
    .map(([key, child]) => {
      const nested = child !== null && typeof child === "object";
      return `${indent}${key}:${nested ? "\n" : " "}${renderText(child, nested ? depth + 1 : 0)}`;
    })
    .join("\n");
}

export interface SurfaceResponse {
  readonly envelope: ResultEnvelope;
  readonly stdout: string;
  readonly exitCode: number;
}

export function respond(
  envelope: ResultEnvelope,
  text = false,
): SurfaceResponse {
  return {
    envelope,
    stdout: `${text ? renderText(envelope) : JSON.stringify(envelope)}\n`,
    exitCode: exitCode(envelope),
  };
}
