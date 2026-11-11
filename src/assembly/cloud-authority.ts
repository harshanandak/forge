// Forge cloud as the authority for a cloud-bound project's `issue show`; not implemented yet.
import type { ForgeFailure } from "../contract/failure.ts";
import type { Runtime } from "../core/runtime/index.ts";
import type { InvocationRequest, ResultEnvelope } from "../generated/types.ts";
import type { CloudLoginDeps } from "./cloud-login.ts";

export interface CloudAuthorityDeps {
  readonly root: string;
  readonly deviceRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cloud?:
    Partial<Pick<CloudLoginDeps, "fetch" | "now" | "security">> | undefined;
}

export function cloudRoute(
  _blockId: string,
  _declared: string,
): "local" | "cloud" | ForgeFailure {
  return "local";
}

export function selectCloud(
  _deps: CloudAuthorityDeps,
  _runtime: Pick<Runtime, "preflight">,
  _request: InvocationRequest,
): Promise<ResultEnvelope | undefined> {
  return Promise.resolve(undefined);
}
