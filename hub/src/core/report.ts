import type { HubCore } from "../contract/core.ts";
import type { CoreContext } from "./core.ts";
import type { EffectWorker } from "./effects.ts";

export function createReport(
  _ctx: CoreContext,
  _worker: EffectWorker,
): HubCore["report"] {
  return () => {
    throw new Error("not_built");
  };
}
