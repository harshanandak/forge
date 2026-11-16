// [integration] Installed-path proof uses real files, including symlink substitution.
import { expect, test } from "bun:test";
import { hash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  installedProof,
  scopeAPhases,
} from "../../../tools/pack-smoke/identity.ts";

test("installed identity accepts only the reviewed clean artifact and accounts for every scope-A phase", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "forge-identity-")));
  const installed = join(root, "node_modules", "forge-workflow");
  const bin = join(installed, "dist", "bin", "forge.js");
  const expected = {
    version: "0.0.1",
    commit: "a".repeat(40),
    digest: hash("sha256", "candidate archive"),
  };
  const identity = { ...expected, dirty: false };
  const phases = scopeAPhases.map((phase) => ({
    phase,
    outcome: "PASS",
    completed: true,
    evidence: `ci://reviewed-run/${phase}`,
    candidateDigest: expected.digest,
  }));
  mkdirSync(join(installed, "dist", "bin"), { recursive: true });
  writeFileSync(bin, "installed artifact");
  try {
    expect(
      installedProof(installed, bin, expected, identity, phases),
    ).toMatchObject({
      status: "OK",
      exitCode: 0,
      bin: resolve(bin),
      identity,
      missing: [],
    });
    expect(installedProof(installed, bin, expected, identity)).toMatchObject({
      status: "INCOMPLETE",
      exitCode: 2,
      missing: [...scopeAPhases],
    });
    for (const phase of scopeAPhases) {
      expect(
        installedProof(
          installed,
          bin,
          expected,
          identity,
          phases.filter((p) => p.phase !== phase),
        ),
      ).toMatchObject({
        status: "INCOMPLETE",
        exitCode: 2,
        missing: [phase],
      });
    }
    for (const bad of [
      { evidence: "" },
      { evidence: " \n " },
      { evidence: null },
      { outcome: "SKIPPED" },
      { outcome: "FAIL" },
      { outcome: "INCOMPLETE" },
      { completed: false },
      { completed: undefined },
      { candidateDigest: hash("sha256", "another candidate") },
      { candidateDigest: undefined },
    ]) {
      expect(
        installedProof(installed, bin, expected, identity, [
          { ...phases[0], ...bad },
          ...phases.slice(1),
        ]),
      ).toMatchObject({
        status: "INCOMPLETE",
        exitCode: 2,
        missing: [scopeAPhases[0]],
      });
    }
    for (const records of [
      scopeAPhases,
      [...phases, phases[0]],
      [null, ...phases.slice(1)],
    ]) {
      expect(
        installedProof(installed, bin, expected, identity, records),
      ).toMatchObject({ status: "INCOMPLETE", exitCode: 2 });
    }
    const other = join(root, "old-global-forge.js");
    writeFileSync(other, "old global artifact");
    for (const [candidate, actual] of [
      [other, identity],
      [join(root, "missing-forge.js"), identity],
      [bin, null],
      [bin, {}],
      [bin, { ...identity, version: "0.0.0" }],
      [bin, { ...identity, commit: "b".repeat(40) }],
      [bin, { ...identity, commit: "unknown" }],
      [bin, { ...identity, commit: null }],
      [bin, { ...identity, dirty: true }],
    ] as const) {
      expect(
        installedProof(installed, candidate, expected, actual, phases),
      ).toMatchObject({ status: "FAIL", exitCode: 6, code: "INPUT_INVALID" });
    }
    expect(
      installedProof(
        installed,
        bin,
        { ...expected, commit: "unknown" },
        { ...identity, commit: "unknown" },
        phases,
      ),
    ).toMatchObject({ status: "FAIL", exitCode: 6 });
    // A bin inside the prefix must not resolve through an escaped directory.
    rmSync(join(installed, "dist"), { recursive: true });
    const outside = join(root, "substituted-dist");
    mkdirSync(join(outside, "bin"), { recursive: true });
    writeFileSync(join(outside, "bin", "forge.js"), "substitute");
    symlinkSync(outside, join(installed, "dist"), "junction");
    expect(
      installedProof(installed, bin, expected, identity, phases),
    ).toMatchObject({ status: "FAIL", exitCode: 6 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);
