import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const found = Bun.which("node");
if (!found) throw new Error("Node runtime required");
const node: string = found;
const bin = resolve("dist/bin/forge.js");

function run(root: string, args: string[]) {
  return spawnSync(node, [bin, ...args], {
    cwd: root,
    env: {
      ...process.env,
      FORGE_DEVICE_ROOT: join(root, "device"),
      FORGE_SESSION: "mcp-stdout",
    },
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
}

function malformedConfig(): string {
  const root = mkdtempSync(join(tmpdir(), "forge-mcp-stdout-"));
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(join(root, ".forge/config.yaml"), "{unclosed");
  return root;
}

test("mcp bootstrap failure leaves stdout empty and reports on stderr", () => {
  const root = malformedConfig();
  try {
    const result = run(root, ["--mcp"]);
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.length).toBeGreaterThan(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test("plain cli bootstrap failure keeps its envelope on stdout", () => {
  const root = malformedConfig();
  try {
    const result = run(root, ["issue", "list"]);
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
