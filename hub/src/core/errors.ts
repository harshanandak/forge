import type { HubError, HubErrorCode } from "../contract/errors.ts";

const messages: Record<HubErrorCode, string> = {
  UNAUTHENTICATED: "Authentication required.",
  INPUT_INVALID: "The input is invalid.",
  SESSION_UNKNOWN: "The session is unknown.",
  SESSION_NOT_YOURS: "The session belongs to another person.",
  PROJECT_UNKNOWN: "The project is unknown.",
  NOT_PROJECT_MEMBER: "The person is not a member of this project.",
  PERSON_UNKNOWN: "The person is unknown.",
  REPLY_ONLY: "This session is in reply-only mode.",
  PERMIT_REQUIRED: "An approved work request is required.",
  AUTHORITY_ASK_REFUSED: "This approval must be typed by the owner.",
  WORK_REQUEST_SOURCE_INVALID: "The work request needs a valid source.",
  ACK_INVALID: "An acknowledged item was not delivered to this session.",
  CONVERSATION_UNKNOWN: "The conversation is unknown.",
  CONVERSATION_NOT_YOURS: "The conversation belongs to another person.",
  CONVERSATION_PAUSED: "The conversation is paused.",
  SECRET_IN_TEXT: "The text contains a possible secret.",
  CHAT_UNAVAILABLE: "Chat is unavailable.",
  BLOCK_DISABLED: "This feature is disabled in the hub configuration.",
  REQUEST_NOT_ALLOWED: "The request is not allowed.",
  INTERNAL: "The hub could not complete the request.",
};

export function fail(code: HubErrorCode, pointer?: string): HubError {
  const reconcile =
    code === "REPLY_ONLY" ||
    code === "PERMIT_REQUIRED" ||
    code === "CHAT_UNAVAILABLE" ||
    code === "INTERNAL";
  const repair =
    code === "REPLY_ONLY"
      ? "Have the owner approve a work request from this session, or start a new session."
      : code === "SESSION_UNKNOWN"
        ? "Call hello again."
        : undefined;
  return {
    code,
    message: messages[code],
    retry: reconcile ? "reconcile_first" : "never",
    ...(pointer === undefined ? {} : { pointer }),
    ...(repair === undefined ? {} : { repair }),
  };
}
