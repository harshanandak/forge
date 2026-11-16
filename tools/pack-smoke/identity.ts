import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { BuildIdentity } from "../../src/version.ts";

export const scopeAPhases = Object.freeze(
  "windows boxes browser tracker restore publication".split(" "),
);

export interface PhaseResult {
  readonly phase: string;
  readonly outcome: string;
  readonly completed: boolean;
  readonly evidence: string;
  readonly candidateDigest: string;
}

export function installedProof(
  installedDir: string,
  bin: string,
  expected: { version: string; commit: string; digest: string },
  identity: unknown,
  phases: readonly unknown[] = [],
) {
  const actual = identity as Partial<BuildIdentity> | null;
  const missing = scopeAPhases.filter((phase) => {
    const records = phases.filter(
      (value) => (value as Partial<PhaseResult> | null)?.phase === phase,
    );
    const record = records[0] as Partial<PhaseResult> | undefined;
    return (
      records.length !== 1 ||
      record?.outcome !== "PASS" ||
      record.completed !== true ||
      typeof record.evidence !== "string" ||
      record.evidence.trim().length === 0 ||
      record.candidateDigest !== expected.digest
    );
  });
  const target = resolve(installedDir, "dist/bin/forge.js");
  let valid = false;
  try {
    valid =
      resolve(bin) === target &&
      realpathSync(bin) === target &&
      /^[a-f0-9]{40}$/.test(expected.commit) &&
      /^[a-f0-9]{64}$/.test(expected.digest) &&
      actual?.version === expected.version &&
      actual?.commit === expected.commit &&
      actual?.dirty === false;
  } catch {
    /* Missing or substituted installations are invalid proof input. */
  }
  return {
    status: valid ? (missing.length ? "INCOMPLETE" : "OK") : "FAIL",
    exitCode: valid ? (missing.length ? 2 : 0) : 6,
    code: valid ? null : "INPUT_INVALID",
    bin: resolve(bin),
    identity,
    candidateDigest: expected.digest,
    missing,
  };
}
