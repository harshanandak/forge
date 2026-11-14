import { ForgeFailure } from "../../contract/failure.ts";
import type { TrackerItem } from "../../generated/types.ts";
import type { StateClient } from "../../ports/state.ts";
import {
  boundLaneKey,
  readBoundLane,
  type BoundProject,
} from "./bound-lane-state.ts";

export const BOUND_LANES: ReadonlySet<string> = new Set(
  ["start", "show", "status", "next", "record", "close", "release"].map(
    (verb) => `lane.${verb}`,
  ),
);
type ReadIssue = (id: string, canonical?: true) => Promise<TrackerItem>;

export async function boundLaneRead(
  op: string,
  input: { readonly id?: string },
  project: BoundProject,
  state: Pick<StateClient, "get" | "list"> | undefined,
  issue: ReadIssue,
): Promise<unknown> {
  const prefix = boundLaneKey(project);
  if (op === "lane.show") {
    // Resolve with authority before interpreting a display prefix as a stored identity.
    const fresh = await issue(input.id!);
    const id = `work-${fresh.id.replace(/^.*-/, "")}`;
    const found = state?.get(prefix + id);
    if (!found)
      throw new ForgeFailure({
        code: "NOT_FOUND",
        message: `No device lane for ${fresh.id}`,
        retry: "never",
      });
    const record = readBoundLane(found.value, id);
    return {
      ...record.lane,
      issue: fresh.id,
      ...(fresh.lease ? { lease: fresh.lease } : {}),
    };
  }
  const lanes = [];
  for (const found of state?.list(prefix) ?? []) {
    const record = readBoundLane(found.value, found.key.slice(prefix.length));
    const fresh = await issue(record.id, true);
    const current = fresh.lease;
    const held =
      current?.generation === record.grant.generation &&
      current.holder.actor.kind === record.grant.holder.actor.kind &&
      current.holder.actor.id === record.grant.holder.actor.id &&
      current.holder.session.id === record.grant.holder.session.id &&
      current.holder.session.device === record.grant.holder.session.device;
    lanes.push({
      id: fresh.id,
      step: record.active ? (held ? "attached" : "stale") : "inactive",
      stopped: false,
      calls: { used: 0, limit: 0 },
      activeHours: { used: 0, limit: 0 },
      rounds: { review: { used: 0, limit: 0 }, ci: { used: 0, limit: 0 } },
    });
  }
  return {
    enabled: false,
    stopped: false,
    stoppedLanes: [],
    hold: "Device-local attachments only; dispatch is not enabled.",
    lanes,
  };
}
