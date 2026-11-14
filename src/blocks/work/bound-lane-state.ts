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
export interface BoundProgress {
  generation: number;
  actions: number;
  records: number;
  review: number;
  ci: number;
  started: number;
  pending: boolean;
  head?: string;
  verdict?: { head: string; verdict: "MERGE" | "FIX"; reviewer: string };
  ask?: {
    reason: string;
    releaseTotal: string;
    default: string;
    answer?: string;
  };
}
const shape = (value: unknown, required: string[], optional: string[] = []) =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => [...required, ...optional].includes(key));
const text = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 2000;
export function validBoundProgress(value: unknown): value is BoundProgress {
  if (
    !shape(
      value,
      ["actions", "records", "review", "ci", "started", "pending"],
      ["head", "verdict", "ask", "generation"],
    )
  )
    return false;
  const p = value as BoundProgress;
  return (
    Number.isSafeInteger(p.generation) &&
    p.generation > 0 &&
    [p.actions, p.records, p.review, p.ci, p.started].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) &&
    typeof p.pending === "boolean" &&
    (!p.pending || (p.actions > 0 && validBoundHead(p.head))) &&
    (p.head === undefined || validBoundHead(p.head)) &&
    (p.verdict === undefined ||
      (shape(p.verdict, ["head", "verdict", "reviewer"]) &&
        validBoundHead(p.verdict.head) &&
        p.verdict.head === p.head &&
        ["MERGE", "FIX"].includes(p.verdict.verdict) &&
        text(p.verdict.reviewer))) &&
    (p.ask === undefined ||
      (shape(p.ask, ["reason", "releaseTotal", "default"], ["answer"]) &&
        p.pending &&
        [p.ask.reason, p.ask.releaseTotal, p.ask.default].every(text) &&
        (p.ask.answer === undefined || text(p.ask.answer))))
  );
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
  readonly progress?: BoundProgress;
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
          "progress",
        ].includes(key),
    ) ||
    record.id !== id ||
    !/^work-\d+$/.test(id) ||
    typeof record.cloudId !== "string" ||
    record.cloudId.length > 200 ||
    record.cloudId.match(/^[a-z0-9]+(?:-[a-z0-9]+)*-(\d+)$/)?.[1] !==
      id.slice(5) ||
    typeof record.active !== "boolean" ||
    (record.progress !== undefined &&
      (!validBoundProgress(record.progress) ||
        record.progress.generation !== record.grant?.generation)) ||
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
