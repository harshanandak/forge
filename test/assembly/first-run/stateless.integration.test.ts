import { expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

test("help stays storage-independent while trust diagnostics fail on a refused store", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-stateless-"));
  const deviceRoot = join(root, "OneDrive", "device");
  mkdirSync(deviceRoot, { recursive: true });
  const path = join(deviceRoot, "trust.sqlite");
  writeFileSync(path, "store must never be opened");
  cpSync(resolve("dist/src/blocks/work"), join(root, "work"), {
    recursive: true,
  });
  const node = Bun.which("node");
  if (!node) throw new Error("Node runtime required");
  try {
    for (const args of [
      [],
      ["--help"],
      ["config", "detect"],
      ["catalog", "list"],
      ["catalog", "describe", "config.show"],
      ["template", "list"],
    ]) {
      const reply = spawnSync(node, [resolve("bin/forge.ts"), ...args], {
        cwd: root,
        env: { ...process.env, FORGE_DEVICE_ROOT: deviceRoot },
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
      });
      expect(reply.error).toBeUndefined();
      expect(reply.stdout).not.toContain("filesystem");
      expect(reply.status).toBe(0);
      expect(reply.stderr).toBe("");
    }
    for (const args of [
      ["config", "show"],
      ["block", "check", "./work"],
    ]) {
      const reply = spawnSync(node, [resolve("bin/forge.ts"), ...args], {
        cwd: root,
        env: { ...process.env, FORGE_DEVICE_ROOT: deviceRoot },
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
      });
      expect(reply.error).toBeUndefined();
      expect(reply.status).toBe(1);
      expect(JSON.parse(reply.stdout)).toMatchObject({
        ok: false,
        status: "FAIL",
        error: {
          code: "UNAVAILABLE",
          retry: "never",
        },
        warnings: [],
      });
      expect(reply.stdout).toContain("OneDrive");
      expect(reply.stderr).toBe("");
    }
    expect(readFileSync(path, "utf8")).toBe("store must never be opened");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
