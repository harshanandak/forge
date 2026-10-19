import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
test("generic assembly registers opt-in blocks and fences leased writes", () => {
  const folder = mkdtempSync(join(tmpdir(), "forge-leased-assembly-"));
  try {
    const build = spawnSync(process.execPath, ["run", "build"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
    });
    expect(build.status, build.stderr).toBe(0);
    const fixture = spawnSync(
      "node",
      [join(root, "test/node-fixtures/assembly/leased.mjs"), root, folder],
      { cwd: root, encoding: "utf8", windowsHide: true, timeout: 30000 },
    );
    expect(fixture.status, fixture.stdout + fixture.stderr).toBe(0);
    expect(fixture.stdout).toContain("PASS generic leased assembly");
    const target = join(root, "dist/src/assembly/state-client.js");
    const original = readFileSync(target, "utf8");
    const fixed = "{ fence: fence(put.subject ?? key) }";
    expect(original).toContain(fixed);
    try {
      writeFileSync(target, original.replace(fixed, "{}"));
      const broken = spawnSync(
        "node",
        [
          join(root, "test/node-fixtures/assembly/leased.mjs"),
          root,
          join(folder, "broken"),
        ],
        { cwd: root, encoding: "utf8", windowsHide: true, timeout: 30000 },
      );
      expect(broken.status).not.toBe(0);
      expect(broken.stderr).toContain("LEASE_STALE");
    } finally {
      writeFileSync(target, original);
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}, 90000);
