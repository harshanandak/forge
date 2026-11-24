import type { CredentialStore, StoreDeps } from "./store.ts";
export function createCredentialStore(
  _deps: Pick<StoreDeps, "db" | "people" | "now">,
): CredentialStore {
  throw new Error("not_built");
}
