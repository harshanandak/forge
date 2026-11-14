import { ForgeFailure } from "../../contract/failure.ts";
import type { LeaseRecord } from "../../generated/types.ts";
import {
  validateLeaseRecord,
  validateRequestId,
} from "../../generated/validators.ts";
import type { StateClient } from "../../ports/state.ts";
import type { StateRecord } from "../../generated/types.ts";

export function validBoundHead(value: unknown): value is string {
  return (
    typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
  );
}

export interface BoundProject {
  readonly origin: string;
  readonly identity: string;
  readonly project: string;
}
export interface BoundLaneRecord {
  readonly version: 1;
  readonly id: string;
  readonly cloudId: string;
  readonly lane: {
    readonly issue: string;
    readonly issueId?: string;
    readonly worktree: string;
    readonly branch: string;
    readonly brief: string;
  };
  readonly grant: LeaseRecord;
  readonly active: boolean;
  readonly releaseNeeded?: boolean;
  readonly releaseRequestId?: string;
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
      (key) =>
        ![
          "version",
          "id",
          "cloudId",
          "lane",
          "grant",
          "active",
          "releaseNeeded",
          "releaseRequestId",
        ].includes(key),
    ) ||
    record.id !== id ||
    !/^work-\d+$/.test(id) ||
    typeof record.cloudId !== "string" ||
    record.cloudId.length > 200 ||
    record.cloudId.match(/^[a-z0-9]+(?:-[a-z0-9]+)*-(\d+)$/)?.[1] !==
      id.slice(5) ||
    typeof record.active !== "boolean" ||
    (record.releaseNeeded !== undefined &&
      typeof record.releaseNeeded !== "boolean") ||
    (record.releaseRequestId !== undefined &&
      (!validateRequestId(record.releaseRequestId).ok ||
        record.releaseNeeded !== true)) ||
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

export function writeBoundLane(
  state: StateClient,
  project: BoundProject,
  value: BoundLaneRecord,
  expectRevision: number,
): StateRecord {
  return state.put(
    boundLaneKey(project, value.id),
    readBoundLane(value, value.id),
    { expectRevision },
  );
}
