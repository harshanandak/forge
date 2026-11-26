import { readFileSync } from "node:fs";
import type { InspectResult } from "./lane-step-contract.ts";

interface Holder {
  readonly actor: string;
  readonly session: string;
  readonly device?: string;
}

export interface LaneRecord {
  readonly issue: string;
  readonly worktree: string;
  readonly branch: string;
  readonly brief: string;
  readonly lease?: { readonly holder: Holder; readonly expiresAt: string };
}

export interface WorkspaceState {
  readonly branch: string;
  readonly head: string;
  readonly status: string;
}

export interface InspectReads {
  readonly lane: (issue: string) => Promise<LaneRecord | undefined>;
  readonly brief: (path: string) => Promise<Uint8Array>;
  readonly workspace: (path: string) => Promise<WorkspaceState>;
  readonly caller: () => Promise<Holder | undefined>;
  readonly now: () => number;
}

export function inspect(
  _input: unknown,
  _reads?: InspectReads,
): Promise<InspectResult> {
  return Promise.resolve({
    status: "refused",
    field: "request",
    code: "not_built",
  });
}

async function inspectCommand(argv: readonly string[]): Promise<InspectResult> {
  if (argv.length !== 1 || argv[0] !== "inspect") {
    return { status: "refused", field: "command", code: "INPUT_INVALID" };
  }
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return { status: "refused", field: "request", code: "INPUT_INVALID" };
  }
  return inspect(input);
}

if (import.meta.main) {
  const result = await inspectCommand(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === "context" ? 0 : 2;
}
