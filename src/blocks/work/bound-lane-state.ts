import { ForgeFailure } from "../../contract/failure.ts";
import type { LeaseRecord } from "../../generated/types.ts";
import {
  validateLeaseRecord,
  validateRequestId,
} from "../../generated/validators.ts";
import type { StateClient } from "../../ports/state.ts";
import type { StateRecord } from "../../generated/types.ts";
import type { GitScope } from "../../assembly/providers.ts";
import { validGitScope } from "../../assembly/saved-git-scope.ts";

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
  counted?: { action: number; review: boolean; ci: boolean };
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
      ["head", "verdict", "ask", "generation", "counted"],
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
    (p.counted === undefined ||
      (shape(p.counted, ["action", "review", "ci"]) &&
        p.counted.action === p.actions &&
        typeof p.counted.review === "boolean" &&
        typeof p.counted.ci === "boolean")) &&
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
    readonly gitScope?: GitScope;
  };
  readonly grant: LeaseRecord;
  readonly active: boolean;
  readonly releaseNeeded?: boolean;
  readonly releaseRequestId?: string;
  readonly progress?: BoundProgress;
}
export const boundLaneKey = (project: BoundProject, id = "") =>
  `bound-lane:${JSON.stringify([project.origin, project.identity, project.project])}:${id}`;
const serializedString = String.raw`"(?:[^"\\\u0000-\u001f\uD800-\uDFFF]|\\(?:["\\bfnrt]|u00(?:0[0-7bef]|1[0-9a-f])|ud[89ab][0-9a-f]{2}(?!\\ud[c-f][0-9a-f]{2})|ud[c-f][0-9a-f]{2}))*"`;
export const boundLanePattern: RegExp = new RegExp(
  `^bound-lane:\\[${serializedString},${serializedString},${serializedString}\\]:work-[0-9]+$`,
  "u",
);
export function readBoundLaneKey(
  key: string,
): (BoundProject & { id: string }) | undefined {
  if (boundLanePattern.exec(key)?.[0] !== key) return;
  const id = key.slice(key.lastIndexOf(":") + 1);
  const tuple: unknown = JSON.parse(key.slice(11, key.lastIndexOf(":")));
  if (
    !Array.isArray(tuple) ||
    tuple.length !== 3 ||
    !tuple.every(
      (part) => typeof part === "string" && !/[\p{Cc}\p{Cf}]/u.test(part),
    )
  )
    return;
  const [origin, identity, project] = tuple as [string, string, string];
  const value = { origin, identity, project, id };
  return boundLaneKey(value, id) === key ? value : undefined;
}

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
        ![
          "issue",
          "issueId",
          "worktree",
          "branch",
          "brief",
          "gitScope",
        ].includes(key),
    ) ||
    (lane.gitScope !== undefined && !validGitScope(lane.gitScope)) ||
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
  const key = boundLaneKey(project, value.id);
  if (!readBoundLaneKey(key))
    throw new ForgeFailure({
      code: "INPUT_INVALID",
      message: "WORK_VALUE_KEY",
      retry: "never",
    });
  return state.put(key, readBoundLane(value, value.id), { expectRevision });
}
