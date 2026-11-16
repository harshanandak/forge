import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { BuildIdentity } from "../../src/version.ts";

export const scopeAPhases =
  "windows boxes browser tracker restore publication".split(" ");

export function installedProof(
  installedDir: string,
  bin: string,
  expected: { version: string; commit: string },
  identity: unknown,
  phases: readonly unknown[] = [],
) {
  const actual = identity as Partial<BuildIdentity> | null;
  const missing = scopeAPhases.filter((phase) => !phases.includes(phase));
  const target = resolve(installedDir, "dist/bin/forge.js");
  let valid = false;
  try {
    valid =
      resolve(bin) === target &&
      realpathSync(bin) === target &&
      /^[a-f0-9]{40}$/.test(expected.commit) &&
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
    missing,
  };
}
