import type {
  FailureEnvelope,
  ResultEnvelope,
  UpgradeHint,
} from "../generated/types.ts";

function isUpgradeHint(value: unknown): value is UpgradeHint {
  if (
    typeof value !== "object" ||
    value === null ||
    !("running" in value) ||
    !("required" in value) ||
    typeof value.required !== "string" ||
    !("command" in value) ||
    typeof value.command !== "string"
  )
    return false;
  const running = value.running;
  return (
    typeof running === "object" &&
    running !== null &&
    "version" in running &&
    typeof running.version === "string" &&
    "commit" in running &&
    (running.commit === null || typeof running.commit === "string") &&
    "dirty" in running &&
    typeof running.dirty === "boolean"
  );
}

function displayText(text: string): string {
  return text.replace(
    /(?![\n\t])[\p{Cc}\u2028\u2029]/gu,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function displayMessage<T extends { readonly message: string }>(value: T): T {
  return { ...value, message: displayText(value.message) };
}

export function displayEnvelope(envelope: ResultEnvelope): ResultEnvelope {
  return {
    ...envelope,
    ...(!envelope.ok ? { error: displayMessage(envelope.error) } : {}),
    warnings: envelope.warnings.map(displayMessage),
  };
}

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
      message: displayText(message),
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
  if (value === null || typeof value !== "object")
    return displayText(String(value));
  const indent = "  ".repeat(depth);
  return Object.entries(value)
    .map(([key, child]) => {
      if (key === "hint" && isUpgradeHint(child)) {
        const hint = child;
        return `${indent}hint: ${displayText(
          `Running Forge ${hint.running.version} (${hint.running.commit ?? "unbuilt"}${hint.running.dirty ? "+dirty" : ""}); repo needs ${hint.required}; run: ${hint.command}`,
        )
          .replaceAll("\n", "\\n")
          .replaceAll("\t", "\\t")}`;
      }
      const nested = child !== null && typeof child === "object";
      return `${indent}${displayText(key)}:${nested ? "\n" : " "}${renderText(child, nested ? depth + 1 : 0)}`;
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
  envelope = displayEnvelope(envelope);
  return {
    envelope,
    stdout: `${text ? renderText(envelope) : JSON.stringify(envelope)}\n`,
    exitCode: exitCode(envelope),
  };
}
