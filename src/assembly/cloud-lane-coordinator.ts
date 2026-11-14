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
  let prefix: string | undefined;
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
        if (prefix === undefined) {
          const page = (await command("issue.list", { limit: 1 })) as {
            items: TrackerItem[];
          };
          const first = page.items[0];
          if (!first)
            throw new ForgeFailure({
              code: "NOT_FOUND",
              message: "No cloud issues for the device attachment.",
              retry: "never",
            });
          prefix = first.id.replace(/-\d+$/, "");
        }
        id = `${prefix}-${id.slice(5)}`;
      }
      return (await command("issue.show", { id })) as TrackerItem;
    },
  );
}
