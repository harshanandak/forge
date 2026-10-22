import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ResultEnvelope } from "../../src/generated/types.ts";

const bin = resolve(import.meta.dirname, "../../dist/bin/forge.js");

function project() {
  const work = mkdtempSync(join(tmpdir(), "forge-deleted-store-"));
  const root = join(work, "project");
  const device = join(work, "device");
  mkdirSync(join(root, ".forge"), { recursive: true });
  // Config is written before the first state write; it alone cannot prove a lost store.
  writeFileSync(join(root, ".forge/config.yaml"), "blocks:\n  work: {}\n");
  return {
    work,
    root,
    device,
    cli(args: string[], status: number): ResultEnvelope {
      const result = spawnSync("node", [bin, ...args], {
        cwd: root,
        env: { ...process.env, FORGE_DEVICE_ROOT: device },
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(status);
      return JSON.parse(result.stdout) as ResultEnvelope;
    },
  };
}

test("fresh configured project reads still create no project or device store", () => {
  const p = project();
  try {
    expect(p.cli(["issue", "list"], 0)).toMatchObject({
      ok: true,
      result: { items: [] },
    });
    expect(p.cli(["issue", "show", "project-1"], 3)).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(readdirSync(join(p.root, ".forge"))).toEqual(["config.yaml"]);
    expect(existsSync(p.device)).toBe(false);
  } finally {
    rmSync(p.work, { recursive: true, force: true });
  }
}, 60_000);

for (const lost of ["database", "directory"] as const) {
  for (const read of ["list", "show"] as const) {
    test(`a missing established ${lost} refuses ${read} and supports explicit recovery`, () => {
      const p = project();
      const path = join(p.root, ".forge/state.sqlite");
      const saved = join(p.work, "backup");
      try {
        expect(
          p.cli(["issue", "create", "--title", "Original"], 0),
        ).toMatchObject({ ok: true, result: { id: "project-1" } });
        const config = readFileSync(join(p.root, ".forge/config.yaml"));
        if (lost === "database") {
          copyFileSync(path, saved);
          rmSync(path);
        } else {
          renameSync(join(p.root, ".forge"), saved);
        }
        if (lost === "directory") {
          mkdirSync(join(p.root, ".forge"));
          writeFileSync(join(p.root, ".forge/config.yaml"), config);
        }
        const args =
          read === "list" ? ["issue", "list"] : ["issue", "show", "project-1"];
        const result = p.cli(args, 1);
        expect(result).toMatchObject({
          ok: false,
          error: { code: "UNAVAILABLE", retry: "never" },
        });
        if (result.ok) throw Error("Expected missing store failure");
        expect(result.error.message).toContain(path);
        expect(result.error.message).toContain("restore from backup");
        expect(result.error.message).toContain("explicitly re-initialize");
        expect(result.error.message).toContain("forge issue create");
        expect(existsSync(path)).toBe(false);
        // Restoring the database recovers the original data without re-initializing.
        if (lost === "database") copyFileSync(saved, path);
        else {
          rmSync(join(p.root, ".forge"), { recursive: true });
          renameSync(saved, join(p.root, ".forge"));
        }
        expect(p.cli(["issue", "show", "project-1"], 0)).toMatchObject({
          ok: true,
          result: { title: "Original" },
        });
        rmSync(path);
        // An explicit state write starts over; reads never do so on the caller's behalf.
        expect(
          p.cli(["issue", "create", "--title", "Start over"], 0),
        ).toMatchObject({ ok: true, result: { id: "project-1" } });
        expect(p.cli(["issue", "list"], 0)).toMatchObject({
          ok: true,
          result: { items: [{ title: "Start over" }] },
        });
      } finally {
        rmSync(p.work, { recursive: true, force: true });
      }
    }, 90_000);
  }
}
