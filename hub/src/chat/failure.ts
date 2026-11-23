import type { ChatWriteFailure } from "../contract/chat.ts";

export function slackPlatformCode(_error: unknown): string | undefined {
  throw new Error("not_built");
}

export function toChatWriteFailure(_error: unknown): ChatWriteFailure {
  throw new Error("not_built");
}

export function validateRetryAfterResponse(
  _data: unknown,
  _headers?: unknown,
  _status?: number,
): unknown {
  throw new Error("not_built");
}
