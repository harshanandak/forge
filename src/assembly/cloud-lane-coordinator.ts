import type { Preflight } from "../core/runtime/index.ts";
import type { TrackerItem } from "../generated/types.ts";
import { ForgeFailure } from "../contract/failure.ts";
import { boundLaneRead } from "../blocks/work/bound-lane.ts";
import type { BoundProject } from "../blocks/work/bound-lane-state.ts";
import type { LocalState } from "./state.ts";

/** Device state is opened read-only, separately from the public operation's project context. */
export async function coordinateLane(
  flight: Preflight,
  project: BoundProject,
  device: LocalState,
  command: (op: string, input: object) => Promise<unknown>,
): Promise<unknown> {
  const owner = await device.open(false);
  const prefix = (flight.config as { idPrefix?: string }).idPrefix;
  return boundLaneRead(
    flight.operation.declaredOp,
    flight.request.input as { id?: string },
    project,
    owner && {
      get: (key) => owner.get("forge/work", key),
      list: (prefix) => owner.list("forge/work", prefix),
    },
    async (id, canonical) => {
      if (canonical) {
        if (prefix === undefined)
          throw new ForgeFailure({
            code: "CONTEXT_MISSING",
            message:
              "Configure the bound project's work idPrefix before reading device lane status.",
            retry: "never",
          });
        id = `${prefix}-${id.slice(5)}`;
      }
      return (await command("issue.show", { id })) as TrackerItem;
    },
  );
}
