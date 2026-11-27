import { SUMMARY_KEY_MARKER } from "../contract/chat.ts";
import { AUTHORITY_ACTIONS } from "../contract/domain.ts";
import {
  AUTHORITY_PATTERN,
  hasSecretPattern,
  type HubError,
} from "../contract/errors.ts";
import { LIMITS, type AskInput } from "../contract/mcp.ts";
import { fail } from "./errors.ts";
import type { Guards } from "./store.ts";

export function createGuards(): Guards {
  return {
    fail,
    outboundText(text, pointer) {
      if (hasSecretPattern(text)) return fail("SECRET_IN_TEXT", pointer);
      if (text.includes(SUMMARY_KEY_MARKER))
        return fail("INPUT_INVALID", pointer);
      return undefined;
    },
    storedText: (text) => text.slice(0, LIMITS.storedText),
  };
}

export function validateAskAuthority(
  ask: Pick<AskInput, "kind" | "requestedAction" | "question" | "choices">,
): HubError | undefined {
  if (AUTHORITY_ACTIONS.includes(ask.requestedAction))
    return fail("AUTHORITY_ASK_REFUSED");
  if (ask.requestedAction !== (ask.kind === "choice" ? "choice" : "work"))
    return fail("INPUT_INVALID", "/requestedAction");
  if (
    AUTHORITY_PATTERN.test(ask.question) ||
    ask.choices?.some(({ label }) => AUTHORITY_PATTERN.test(label))
  )
    return fail("AUTHORITY_ASK_REFUSED");
  return undefined;
}
