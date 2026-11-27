export type HubOp =
  | "hub.hello"
  | "hub.inbox"
  | "hub.wait"
  | "hub.reply"
  | "hub.ask"
  | "hub.report"
  | "hub.send"
  | "hub.hook-session"
  | "hub.hook-mode"
  | "hub.hook-stop"
  | "hub.cli-inbox"
  | "hub.cli-send";

export type HubErrorCode =
  | "UNAUTHENTICATED"
  | "INPUT_INVALID"
  | "SESSION_UNKNOWN"
  | "SESSION_NOT_YOURS"
  | "PROJECT_UNKNOWN"
  | "NOT_PROJECT_MEMBER"
  | "PERSON_UNKNOWN"
  | "REPLY_ONLY"
  | "PERMIT_REQUIRED"
  | "AUTHORITY_ASK_REFUSED"
  | "WORK_REQUEST_SOURCE_INVALID"
  | "ACK_INVALID"
  | "CONVERSATION_UNKNOWN"
  | "CONVERSATION_NOT_YOURS"
  | "CONVERSATION_PAUSED"
  | "SECRET_IN_TEXT"
  | "CHAT_UNAVAILABLE"
  | "BLOCK_DISABLED"
  | "REQUEST_NOT_ALLOWED"
  | "INTERNAL";

export type RetryPosture = "never" | "reconcile_first" | "safe";

export interface HubError {
  readonly code: HubErrorCode;
  readonly message: string;
  readonly retry: RetryPosture;
  readonly pointer?: string;
  readonly repair?: string;
}

export const AUTHORITY_PATTERN =
  /\b(merge[sd]?|merging|deploy(?:s|ed|ing|ment|ments)?|release[sd]?|releasing|publish(?:es|ed|ing)?|stop[- ]?lift|lift(?:ing)? the stop|force[- ]push(?:es|ed|ing)?)\b/i;

export const SECRET_PATTERNS: readonly RegExp[] = [
  /xox[abposr]-[A-Za-z0-9-]{10,}/,
  /xapp-[A-Za-z0-9-]{10,}/,
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /github_pat_[A-Za-z0-9_]{30,}/,
  /sk-[A-Za-z0-9_-]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /fh_[A-Za-z0-9_-]{43}/,
  /fhk_[A-Za-z0-9_-]{43}/,
];

export const SECRET_REMOVED_TEXT = "[possible secret removed]";

export function hasSecretPattern(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

export function redactSecretText(text: string): string {
  return hasSecretPattern(text) ? SECRET_REMOVED_TEXT : text;
}

export const HTTP_STATUS: Readonly<Record<HubErrorCode, number>> = {
  UNAUTHENTICATED: 401,
  INPUT_INVALID: 400,
  SESSION_UNKNOWN: 404,
  SESSION_NOT_YOURS: 403,
  PROJECT_UNKNOWN: 404,
  NOT_PROJECT_MEMBER: 403,
  PERSON_UNKNOWN: 400,
  REPLY_ONLY: 403,
  PERMIT_REQUIRED: 403,
  AUTHORITY_ASK_REFUSED: 422,
  WORK_REQUEST_SOURCE_INVALID: 422,
  ACK_INVALID: 422,
  CONVERSATION_UNKNOWN: 404,
  CONVERSATION_NOT_YOURS: 403,
  CONVERSATION_PAUSED: 409,
  SECRET_IN_TEXT: 422,
  CHAT_UNAVAILABLE: 503,
  BLOCK_DISABLED: 503,
  REQUEST_NOT_ALLOWED: 403,
  INTERNAL: 500,
};
