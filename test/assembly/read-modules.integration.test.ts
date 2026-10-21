import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

test("local reads never load the MCP transport or its schema compiler", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-read-modules-"));
  const node = Bun.which("node");
  if (!node) throw new Error("Node runtime required");
  const guard = `import {registerHooks} from 'node:module';
    registerHooks({load(url, context, next) {
      if (/node_modules\\/(?:@modelcontextprotocol|zod)\\//.test(url))
        throw new Error('Read loaded MCP: ' + url);
      return next(url, context);
    }});`;
  mkdirSync(join(root, ".forge"));
  writeFileSync(
    join(root, ".forge/config.yaml"),
    "blocks:\n  work: {}\n  check:\n    config:\n      commands:\n        probe: node --version\n",
  );
  try {
    const initialized = spawnSync("git", ["init", root], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    expect(initialized.status, initialized.stderr).toBe(0);
    for (const args of [
      ["--help"],
      ["config", "show"],
      ["issue", "list"],
      ["check", "list"],
      ["catalog", "describe", "issue.show"],
    ]) {
      const result = spawnSync(
        node,
        [
          "--import",
          `data:text/javascript,${encodeURIComponent(guard)}`,
          resolve("dist/bin/forge.js"),
          ...args,
        ],
        {
          cwd: root,
          env: { ...process.env, FORGE_DEVICE_ROOT: join(root, "device") },
          encoding: "utf8",
          timeout: 15_000,
          windowsHide: true,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe("");
      expect(result.status, result.stdout).toBe(0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
