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

export interface ConsumeRequest {
  readonly context: LaneStepContext;
  readonly step: Readonly<{ kind: "verify-brief" }>;
}

export type ConsumeResult =
  { readonly status: "verified"; readonly brief: Uint8Array } | InspectRefusal;

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

const issueId = (input: unknown): input is string =>
  text(input) && /^[a-z0-9]+(?:-[a-z0-9]+)*-[1-9][0-9]*$/i.test(input);
const digestId = (input: unknown): input is string =>
  text(input) && /^sha256:[0-9a-f]{64}$/.test(input);
const revision = (input: unknown): input is string =>
  text(input) && /^[a-f0-9]{40}$/i.test(input);
const branchName = (input: unknown): input is string =>
  text(input) &&
  input !== "HEAD" &&
  !/^[-/]|[/.]$|[ ~^:?*[\\]|\.\.|@\{|\/\//.test(input) &&
  input
    .split("/")
    .every((part) => !part.startsWith(".") && !part.endsWith(".lock"));

export function parseInspectRequest(input: unknown) {
  if (!object(input)) return invalid("request");
  const field = unexpected(input, requestFields);
  if (field !== undefined) return invalid(field);
  const { issue, brief, workspace, branch, expectedHead } = input;
  if (!object(brief)) return invalid("brief");
  const nested = unexpected(brief, ["path", "digest"]);
  if (nested !== undefined) return invalid(`brief.${nested}`);
  const { path, digest } = brief;
  if (!issueId(issue)) return invalid("issue");
  if (!text(workspace) || !isAbsolute(workspace)) return invalid("workspace");
  if (!branchName(branch)) return invalid("branch");
  if (!text(path) || !isAbsolute(path)) return invalid("brief.path");
  if (!digestId(digest)) return invalid("brief.digest");
  if (!revision(expectedHead)) return invalid("expectedHead");
  return { issue, brief: { path, digest }, workspace, branch, expectedHead };
}

export function parseConsumeRequest(
  input: unknown,
): ConsumeRequest | InspectRefusal {
  if (!object(input)) return invalid("request");
  const field = unexpected(input, ["context", "step"]);
  if (field !== undefined) return invalid(field);
  const { context, step } = input;
  if (!object(context)) return invalid("context");
  const nested = unexpected(context, [
    "issue",
    "workspace",
    "branch",
    "head",
    "digest",
  ]);
  if (nested !== undefined) return invalid(`context.${nested}`);
  const { issue, workspace, branch, head, digest } = context;
  if (!issueId(issue)) return invalid("context.issue");
  if (!text(workspace) || !isAbsolute(workspace))
    return invalid("context.workspace");
  if (!branchName(branch)) return invalid("context.branch");
  if (!revision(head)) return invalid("context.head");
  if (!digestId(digest)) return invalid("context.digest");
  if (!object(step)) return invalid("step");
  const stepField = unexpected(step, ["kind"]);
  if (stepField !== undefined) return invalid(`step.${stepField}`);
  if (step.kind !== "verify-brief") return invalid("step.kind");
  return {
    context: { issue, workspace, branch, head, digest },
    step: { kind: step.kind },
  };
}
