import { ForgeFailure } from "../../contract/failure.ts";
import type { LeaseRecord, StateRecord } from "../../generated/types.ts";
import { validateLeaseRecord } from "../../generated/validators.ts";
import type { StateClient } from "../../ports/state.ts";

export interface BoundProject {
  readonly origin: string;
  readonly identity: string;
  readonly project: string;
}
export interface BoundLaneRecord {
  readonly version: 1;
  readonly id: string;
  readonly lane: {
    readonly issue: string;
    readonly issueId?: string;
    readonly worktree: string;
    readonly branch: string;
    readonly brief: string;
  };
  readonly grant: LeaseRecord;
  readonly active: boolean;
}
export const boundLaneKey = (project: BoundProject, id = "") =>
  `bound-lane:${JSON.stringify([project.origin, project.identity, project.project])}:${id}`;

/** Corrupt device state is diagnostic evidence, never an invitation to initialize over it. */
export function readBoundLane(value: unknown, id: string): BoundLaneRecord {
  const record = value as Partial<BoundLaneRecord> | null;
  const lane = record?.lane;
  if (
    record?.version !== 1 ||
    Object.keys(record).some(
      (key) => !["version", "id", "lane", "grant", "active"].includes(key),
    ) ||
    record.id !== id ||
    !/^work-\d+$/.test(id) ||
    typeof record.active !== "boolean" ||
    !lane ||
    Object.keys(lane).some(
      (key) =>
        !["issue", "issueId", "worktree", "branch", "brief"].includes(key),
    ) ||
    lane.issue !== id ||
    (lane.issueId !== undefined && lane.issueId !== id) ||
    ![lane.worktree, lane.branch, lane.brief].every(
      (field) => typeof field === "string" && field.length > 0,
    ) ||
    !validateLeaseRecord(record.grant).ok ||
    record.grant?.subject !== `issue:${id}`
  )
    throw new ForgeFailure({
      code: "INPUT_CONFLICT",
      message: "Malformed device lane journal; inspect it before retrying.",
      retry: "never",
    });
  return record as BoundLaneRecord;
}

/** The caller supplies the revision it observed; StateOwner rejects a concurrent update. */
export function writeBoundLane(
  state: StateClient,
  project: BoundProject,
  value: BoundLaneRecord,
  expectRevision: number,
): StateRecord {
  const record = readBoundLane(value, value.id);
  return state.put(boundLaneKey(project, record.id), record, {
    expectRevision,
  });
}
