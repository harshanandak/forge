import type { HubCore } from "../contract/core.ts";
import type { CoreDeps } from "../contract/runtime.ts";
import type { CoreStore } from "./store.ts";

export interface CoreExtras {
  readonly kickEffects?: () => void;
}

export type CoreBase = Omit<
  HubCore,
  "report" | "hookStop" | "cliInbox" | "cliSend" | "start" | "close"
>;

export interface CoreContext {
  readonly deps: CoreDeps;
  readonly store: CoreStore;
}

export type CreateCoreContext = (deps: CoreDeps) => CoreContext;
export type CreateCoreBase = (
  ctx: CoreContext,
  extras?: CoreExtras,
) => CoreBase;

export const createCoreContext: CreateCoreContext = (_deps) => {
  throw new Error("not_built");
};

export const createCoreBase: CreateCoreBase = (_ctx, _extras) => {
  throw new Error("not_built");
};
