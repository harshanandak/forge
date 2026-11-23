import type { StateAdapter } from "chat";
import type { HubDb } from "../contract/runtime.ts";

export function createSqliteChatState(_db: HubDb): StateAdapter {
  throw new Error("not_built");
}
