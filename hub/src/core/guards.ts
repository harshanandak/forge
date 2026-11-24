import type { HubError } from "../contract/errors.ts";
import type { AskInput } from "../contract/mcp.ts";
import type { Guards } from "./store.ts";
export function createGuards(): Guards {
  throw new Error("not_built");
}
export function validateAskAuthority(
  _ask: Pick<AskInput, "kind" | "requestedAction" | "question" | "choices">,
): HubError | undefined {
  throw new Error("not_built");
}
