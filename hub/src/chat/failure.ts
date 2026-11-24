import { ChatWriteFailure, type ChatFailureReason } from "../contract/chat.ts";

const uncertainSlackCodes = new Set([
  "fatal_error",
  "internal_error",
  "ratelimited",
  "request_timeout",
  "service_unavailable",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function platformCode(data: unknown): string | undefined {
  if (
    isRecord(data) &&
    data.ok === false &&
    typeof data.error === "string" &&
    /^[a-z][a-z_0-9]*$/.test(data.error)
  )
    return data.error;
  return undefined;
}

export function slackPlatformCode(error: unknown): string | undefined {
  return isRecord(error) && error.code === "slack_webapi_platform_error"
    ? platformCode(error.data)
    : undefined;
}

function refusalReason(
  code: string | undefined,
): ChatFailureReason | undefined {
  switch (code) {
    case "not_in_channel":
    case "channel_not_found":
    case "is_archived":
    case "restricted_action":
      return code;
    default:
      return undefined;
  }
}

function retryDelay(seconds: unknown): number | undefined {
  if (
    typeof seconds !== "number" ||
    !Number.isSafeInteger(seconds) ||
    seconds < 0
  ) {
    return undefined;
  }
  const milliseconds = seconds * 1_000;
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

export function toChatWriteFailure(error: unknown): ChatWriteFailure {
  if (error instanceof ChatWriteFailure)
    return new ChatWriteFailure(error.effect, error.retryAfterMs, error.reason);
  if (!isRecord(error)) return new ChatWriteFailure("unknown");
  if (error.code === "slack_webapi_rate_limited_error") {
    const retryAfterMs = retryDelay(error.retryAfter);
    return retryAfterMs === undefined
      ? new ChatWriteFailure("unknown")
      : new ChatWriteFailure("refused", retryAfterMs);
  }
  if (error.code === "slack_webapi_http_error" && error.statusCode !== 429) {
    const reason = refusalReason(platformCode(error.body));
    if (reason) return new ChatWriteFailure("refused", undefined, reason);
  }
  const code = slackPlatformCode(error);
  return code === undefined || uncertainSlackCodes.has(code)
    ? new ChatWriteFailure("unknown")
    : new ChatWriteFailure("refused", undefined, refusalReason(code));
}

export function validateRetryAfterResponse(
  data: unknown,
  headers?: unknown,
  status?: number,
): unknown {
  if (status !== 429) return data;
  const header =
    isRecord(headers) && Object.hasOwn(headers, "retry-after")
      ? headers["retry-after"]
      : undefined;
  if (
    typeof header !== "string" ||
    header.length === 0 ||
    /[^0-9]/.test(header) ||
    retryDelay(Number(header)) === undefined
  )
    throw new ChatWriteFailure("unknown");
  return data;
}
