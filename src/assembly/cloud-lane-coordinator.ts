import type { Preflight } from "../core/runtime/index.ts";
import type { TrackerItem } from "../generated/types.ts";
import { boundLaneRead } from "../blocks/work/bound-lane.ts";
import type { BoundProject } from "../blocks/work/bound-lane-state.ts";
import type { LocalState } from "./state.ts";

/** Device state is opened read-only, separately from the public operation's project context. */
export async function coordinateLane(
  flight: Preflight,
  project: BoundProject,
  device: LocalState,
  issue: (id: string) => Promise<TrackerItem>,
): Promise<unknown> {
  const owner = await device.open(false);
  return boundLaneRead(
    flight.operation.declaredOp,
    flight.request.input as { id?: string },
    project,
    owner && {
      get: (key) => owner.get("forge/work", key),
      list: (prefix) => owner.list("forge/work", prefix),
    },
    issue,
  );
}
