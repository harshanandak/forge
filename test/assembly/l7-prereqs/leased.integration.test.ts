import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const fixture = join(root, "test/node-fixtures/assembly/leased.mjs");
const run = (source: string, folder: string) =>
  spawnSync("node", [fixture, source, folder], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
  });

// The integration lane builds dist once and parallel workers execute it, so the broken
// variant runs from a private copy; the shared dist is only read.
test("generic assembly registers opt-in blocks and fences leased writes", () => {
  const folder = mkdtempSync(join(tmpdir(), "forge-leased-assembly-"));
  try {
    const passed = run(root, join(folder, "fixed"));
    expect(passed.status, passed.stdout + passed.stderr).toBe(0);
    expect(passed.stdout).toContain("PASS generic leased assembly");
    const copy = join(folder, "copy");
    cpSync(join(root, "dist"), join(copy, "dist"), { recursive: true });
    copyFileSync(join(root, "package.json"), join(copy, "package.json"));
    symlinkSync(
      join(root, "node_modules"),
      join(copy, "node_modules"),
      "junction",
    );
    const target = join(copy, "dist/src/assembly/state-client.js");
    const original = readFileSync(target, "utf8");
    const fixed = "{ fence: fence(put.subject ?? key) }";
    expect(original).toContain(fixed);
    writeFileSync(target, original.replace(fixed, "{}"));
    const broken = run(copy, join(folder, "broken"));
    expect(broken.status).not.toBe(0);
    expect(broken.stderr).toContain("LEASE_STALE");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}, 90000);
