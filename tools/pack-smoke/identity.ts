import type { BuildIdentity } from "../../src/version.ts";

export const scopeAPhases = [
  "windows",
  "boxes",
  "browser",
  "tracker",
  "restore",
  "publication",
] as const;

export function installedProof(
  installedDir: string,
  bin: string,
  expected: { version: string; commit: string },
  identity: BuildIdentity,
  phases: readonly string[] = [],
): {
  status: string;
  exitCode: number;
  bin: string;
  identity: BuildIdentity;
  missing: string[];
} {
  void installedDir;
  void expected;
  void phases;
  throw new Error(
    `installed identity proof is not implemented: ${bin} ${identity.version}`,
  );
}
