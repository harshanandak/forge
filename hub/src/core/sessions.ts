import type { SessionStore, StoreDeps } from "./store.ts";
export function createSessionStore(
  _deps: Pick<StoreDeps, "db" | "config" | "people" | "now">,
): SessionStore {
  throw new Error("not_built");
}
