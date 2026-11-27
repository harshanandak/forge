import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const found = Bun.which("node");
if (!found) throw new Error("Node runtime required");
const node: string = found;
const bin = resolve("dist/bin/forge.js");

function run(root: string, args: string[], input?: string) {
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
    ...(input === undefined ? {} : { input }),
  });
}

function malformedConfig(): string {
  const root = mkdtempSync(join(tmpdir(), "forge-mcp-stdout-"));
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(join(root, ".forge/config.yaml"), "{unclosed");
  return root;
}

function validProject(): string {
  const root = mkdtempSync(join(tmpdir(), "forge-mcp-stdout-"));
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(join(root, ".forge/config.yaml"), "blocks: {}\n");
  return root;
}

test("mcp bootstrap failure leaves stdout empty and reports on stderr", () => {
  const root = malformedConfig();
  try {
    const result = run(root, ["--mcp"]);
    expect(result.error).toBeUndefined();
    expect(typeof result.status).toBe("number");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    const diagnostic = JSON.parse(result.stderr) as {
      ok?: unknown;
      error?: { code?: unknown };
    };
    expect(diagnostic.ok).toBe(false);
    expect(typeof diagnostic.error?.code).toBe("string");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test("plain cli bootstrap failure keeps its envelope on stdout", () => {
  const root = malformedConfig();
  try {
    const result = run(root, ["issue", "list"]);
    expect(result.error).toBeUndefined();
    expect(typeof result.status).toBe("number");
    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test("valid mcp session answers initialize and exits cleanly", () => {
  const root = validProject();
  try {
    const result = run(
      root,
      ["--mcp"],
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "stdout", version: "1.0.0" },
        },
      })}\n`,
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const lines = result.stdout
      .split("\n")
      .filter((line) => line.trim() !== "");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines)
      expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
