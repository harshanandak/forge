import check from "../check/entry.cts";
import type * as Check from "../check/types.ts";
interface HostedCheck {
  repo: string;
  hostedGate: (
    services: Omit<Check.CheckServices, "output" | "state" | "snapshot">,
    input: Check.GateInput,
    config: Pick<Check.CheckConfig, "timeoutMs">,
    scope: Check.CheckInvocationScope,
    head: string,
  ) => Promise<Check.GateResult>;
}
export const hostedCheck: HostedCheck = check as unknown as HostedCheck;
export const isCommit = (value: unknown): value is string =>
  typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
export const validReceipt = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 200;
export const validReason = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.trim() === value &&
  Array.from(value).length <= 65536;
export const normalizedEvidenceSha = (value: unknown): string | undefined =>
  typeof value === "string" && /^[a-fA-F0-9]{40}$/.test(value)
    ? value.toLowerCase()
    : undefined;
export function evidenceProblem(value: {
  sha: unknown;
  metrics?: unknown;
}): "sha" | "metrics" | undefined {
  if (normalizedEvidenceSha(value.sha) === undefined) return "sha";
  const metrics = value.metrics;
  if (
    metrics !== undefined &&
    (metrics === null ||
      typeof metrics !== "object" ||
      Array.isArray(metrics) ||
      Object.keys(metrics).length > 32 ||
      Object.values(metrics).some(
        (v: unknown) =>
          typeof v !== "string" &&
          (typeof v !== "number" || !Number.isFinite(v)),
      ))
  )
    return "metrics";
  return undefined;
}
export const ASK = (id: string): string => `autopilot-ask:${id}`;
export const journalKey = (id: string): string => `autopilot:${id}`;
export const clockKey = (id: string): string => `autopilot-clock:${id}`;
export const MERGE_KEY = (id: string): string => `autopilot-merge:${id}`;
export function approvalFor<T>(
  approve: boolean | undefined,
  request: string | undefined,
  quote: string,
  source: T,
): { request: string; quote: string; source: T } | undefined {
  return approve && request !== undefined
    ? { request, quote, source }
    : undefined;
}
export interface BoundProject {
  readonly origin: string;
  readonly identity: string;
  readonly project: string;
}
export const boundLaneKey = (project: BoundProject, id = ""): string =>
  `bound-lane:${JSON.stringify([project.origin, project.identity, project.project])}:${id}`;
const serializedString = String.raw`"(?:[^"\\\u0000-\u001f\uD800-\uDFFF]|\\(?:["\\bfnrt]|u00(?:0[0-7bef]|1[0-9a-f])|ud[89ab][0-9a-f]{2}(?!\\ud[c-f][0-9a-f]{2})|ud[c-f][0-9a-f]{2}))*"`;
export const boundLanePattern: RegExp = new RegExp(
  `^bound-lane:\\[${serializedString},${serializedString},${serializedString}\\]:work-[0-9]+$`,
  "u",
);
export function readBoundLaneKey(
  key: string,
): (BoundProject & { id: string }) | undefined {
  if (boundLanePattern.exec(key)?.[0] !== key) return undefined;
  const end = key.lastIndexOf(":");
  const tuple: unknown = JSON.parse(key.slice("bound-lane:".length, end));
  if (
    !Array.isArray(tuple) ||
    tuple.length !== 3 ||
    !tuple.every(
      (part: unknown) =>
        typeof part === "string" && !/[\p{Cc}\p{Cf}]/u.test(part),
    )
  )
    return undefined;
  const [origin, identity, project] = tuple as [string, string, string];
  const value = { origin, identity, project, id: key.slice(end + 1) };
  return boundLaneKey(value, value.id) === key ? value : undefined;
}
