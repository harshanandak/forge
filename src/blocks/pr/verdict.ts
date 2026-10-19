import entry from "./entry.cts";
import { contracts, schemaRef, evidenceDigest } from "./contract.ts";
import type { BlockerCode } from "./contract.ts";
export interface Policy {
  minApprovals: number;
  settleMs: number;
  optionalChecks: "ignore" | "safe-terminal";
  allowNoChecks: boolean;
  blockingLabels: readonly string[];
  mergeMethod: "squash";
}
export interface Evidence {
  observedAt: string;
  core: null | {
    headSha: string;
    state: string;
    draft: boolean;
    mergeable: string;
    updatedAt: string;
    host: {
      canBypass: boolean | null;
      mergeStateStatus: string;
      allowedMergeMethods: string[];
    };
  };
  checks: {
    name: string;
    appId: number | null;
    headSha: string;
    status: string;
    conclusion: string | null;
    startedAt: string | null;
    runId?: string;
  }[];
  requiredChecks: { name: string; appId: number | null; strict: boolean }[];
  reviews: {
    id: string;
    author: string | null;
    authorizing: boolean;
    state: string;
    commitSha: string;
    submittedAt: string | null;
    createdAt: string;
    updatedAt: string;
  }[];
  labels: string[];
  requirements: { kind: string; state: string; reason: string }[];
  gaps: { area: string; code: string }[];
}
export interface Verdict {
  status: string;
  blockers: {
    code: BlockerCode;
    message: string;
    ref?: Record<string, string>;
  }[];
  ignored: { category: "checks" | "reviews"; ref: string; reason: string }[];
  evidenceDigest: string;
}
/** Schema validation and digest use the shared contracts; the captured entry owns the pure rules. */
export function verdict(
  evidence: unknown,
  policy: Policy,
  now: number,
): Verdict {
  const checked = contracts.validator<Evidence>(schemaRef("Evidence"))(
    evidence,
  );
  if (!checked.ok) throw new Error("Invalid evidence");
  return (
    entry as unknown as {
      compute(e: Evidence, p: Policy, n: number, d: string): Verdict;
    }
  ).compute(checked.value, policy, now, evidenceDigest(evidence));
}
