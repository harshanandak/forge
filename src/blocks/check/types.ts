import type {
  ProcessPort,
  ProcessOutputEvidence,
} from "../../ports/process.ts";
import type { ClockPort } from "../../ports/clock.ts";
import type { StateClient } from "../../ports/state.ts";
import type { RunnerOutputPort } from "../../ports/runner-output.ts";
export type {
  RunnerOutputPort,
  OutputReport,
} from "../../ports/runner-output.ts";

export type CheckStatus = "PASS" | "FAIL" | "INCOMPLETE" | "NOT_EXECUTED";
export interface CommandDeclaration {
  readonly argv: readonly string[];
  readonly report?: "auto" | "json" | "exit-code";
}
export interface CheckConfig {
  readonly commands: Readonly<Record<string, string | CommandDeclaration>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly outputHeadBytes: number;
  readonly outputTailBytes: number;
  readonly maxMetadataBytes: number;
  readonly maxReceiptBytes: number;
  readonly report: "auto" | "json" | "exit-code";
  readonly stopOnFailure: boolean;
  readonly inputs: readonly string[];
  readonly maxInputBytes: number;
  readonly environment: readonly string[];
  readonly review?: { readonly rounds?: number };
  readonly gate?: {
    readonly requiredChecks?: "github-required" | readonly string[];
    readonly receiptChecks?: readonly string[];
    readonly doorPaths?: readonly string[];
  };
}
export interface GateInput {
  readonly pr: number;
}
export interface GateResult {
  readonly verdict: "PASS" | "REFUSED";
  readonly head: string;
  readonly receipt?: string;
  readonly checks: readonly { readonly name: string; readonly state: string }[];
  readonly unresolvedThreads: number;
  readonly doorPaths: readonly string[];
  readonly reasons: readonly {
    readonly code: string;
    readonly detail: string;
  }[];
}
export interface MergeResult {
  readonly outcome:
    "MERGED" | "REFUSED" | "HEAD_MOVED" | "MERGE_REFUSED" | "MERGE_UNVERIFIED";
  readonly pr: number;
  readonly head: string;
  readonly receipt?: string;
  readonly mergeCommit?: string;
  readonly detail?: string;
  readonly readbackProcess?: {
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly timedOut: boolean;
    readonly truncated: boolean;
    readonly stdout: string;
    readonly stderr: string;
  };
  readonly gate: GateResult;
}
export interface RunInput {
  readonly checks?: readonly string[];
  readonly trigger?: string;
}
/** Invocation lifetime supplied by the approved async author ABI. */
export interface CheckInvocationScope {
  readonly signal: AbortSignal;
  readonly deadline: number;
}
export interface InputSnapshot {
  readonly head: string;
  /** Digest of the actual input files, including uncommitted content. */
  readonly filesDigest: string;
}
export interface CheckServices {
  readonly root: string;
  /** Complete, explicitly selected child environment. Never inherited by the block. */
  readonly environment: Readonly<Record<string, string>>;
  readonly process: ProcessPort;
  readonly clock: ClockPort;
  readonly output: RunnerOutputPort;
  readonly state: StateClient;
  readonly snapshot: () => Promise<InputSnapshot>;
}
export interface CheckRun {
  readonly name: string;
  readonly argv: readonly string[];
  readonly executable: string | null;
  readonly status: CheckStatus;
  readonly testCount: number | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutEvidence: ProcessOutputEvidence | null;
  readonly stderrEvidence: ProcessOutputEvidence | null;
  readonly durationMs: number;
  readonly reason: string;
}
export interface CheckReceipt {
  readonly version: 1;
  readonly id: string;
  readonly status: CheckStatus;
  readonly subject: string;
  readonly checkedAt: string;
  readonly checked: readonly {
    readonly name: string;
    readonly status: CheckStatus;
  }[];
  readonly reason: string;
  readonly inputsDigest: string;
  readonly digest: string;
  readonly runs: readonly CheckRun[];
}
