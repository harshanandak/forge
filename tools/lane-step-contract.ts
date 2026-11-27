import { isAbsolute } from "node:path";

export interface InspectRequest {
  readonly issue: string;
  readonly brief: Readonly<{ path: string; digest: string }>;
  readonly workspace: string;
  readonly branch: string;
  readonly expectedHead: string;
}

type Target = Pick<InspectRequest, "issue" | "workspace" | "branch">;
export type LaneStepContext = Target &
  Readonly<{ head: string; digest: string }>;

export interface InspectRefusal {
  readonly status: "refused";
  readonly field: string;
  readonly code: string;
}

export type InspectResult =
  | { readonly status: "context"; readonly context: LaneStepContext }
  | InspectRefusal;

export function refuse(field: string, code: string): InspectRefusal {
  return { status: "refused", field, code };
}

const invalid = (field: string) => refuse(field, "INPUT_INVALID");
const requestFields = ["issue", "brief", "workspace", "branch", "expectedHead"];

function object(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function unexpected(row: Record<string, unknown>, keys: string[]) {
  const extra = Object.keys(row).find((key) => !keys.includes(key));
  return extra ?? keys.find((key) => !Object.hasOwn(row, key));
}

function text(input: unknown): input is string {
  if (typeof input !== "string" || input !== input.trim()) return false;
  return /^[^\p{Cc}]+$/u.test(input);
}

export function parseInspectRequest(input: unknown) {
  if (!object(input)) return invalid("request");
  const field = unexpected(input, requestFields);
  if (field !== undefined) return invalid(field);
  const { issue, brief, workspace, branch, expectedHead } = input;
  if (!object(brief)) return invalid("brief");
  const nested = unexpected(brief, ["path", "digest"]);
  if (nested !== undefined) return invalid(`brief.${nested}`);
  const { path, digest } = brief;
  if (!text(issue) || !/^[a-z0-9]+(?:-[a-z0-9]+)*-[1-9][0-9]*$/i.test(issue))
    return invalid("issue");
  if (!text(workspace) || !isAbsolute(workspace)) return invalid("workspace");
  if (!text(branch)) return invalid("branch");
  if (!text(path) || !isAbsolute(path)) return invalid("brief.path");
  if (!text(digest) || !/^sha256:[0-9a-f]{64}$/.test(digest))
    return invalid("brief.digest");
  if (!text(expectedHead) || !/^[a-f0-9]{40}$/i.test(expectedHead))
    return invalid("expectedHead");
  return { issue, brief: { path, digest }, workspace, branch, expectedHead };
}
