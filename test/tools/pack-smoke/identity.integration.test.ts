// [integration] Installed-path proof uses real files, including symlink substitution.
import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
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
  const root = mkdtempSync(join(tmpdir(), "forge-identity-"));
  const installed = join(root, "node_modules", "forge-workflow");
  const bin = join(installed, "dist", "bin", "forge.js");
  const expected = { version: "0.0.1", commit: "a".repeat(40) };
  const identity = { ...expected, dirty: false };
  mkdirSync(join(installed, "dist", "bin"), { recursive: true });
  writeFileSync(bin, "installed artifact");
  try {
    expect(
      installedProof(installed, bin, expected, identity, scopeAPhases),
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
          scopeAPhases.filter((p) => p !== phase),
        ),
      ).toMatchObject({
        status: "INCOMPLETE",
        exitCode: 2,
        missing: [phase],
      });
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
        installedProof(installed, candidate, expected, actual, scopeAPhases),
      ).toMatchObject({ status: "FAIL", exitCode: 6, code: "INPUT_INVALID" });
    }
    expect(
      installedProof(
        installed,
        bin,
        { ...expected, commit: "unknown" },
        { ...identity, commit: "unknown" },
        scopeAPhases,
      ),
    ).toMatchObject({ status: "FAIL", exitCode: 6 });
    // A bin inside the prefix must not resolve through an escaped directory.
    rmSync(join(installed, "dist"), { recursive: true });
    const outside = join(root, "substituted-dist");
    mkdirSync(join(outside, "bin"), { recursive: true });
    writeFileSync(join(outside, "bin", "forge.js"), "substitute");
    symlinkSync(outside, join(installed, "dist"), "junction");
    expect(
      installedProof(installed, bin, expected, identity, scopeAPhases),
    ).toMatchObject({ status: "FAIL", exitCode: 6 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);
