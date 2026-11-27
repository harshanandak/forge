import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function run(config: string, args: string[], input?: string) {
  const node = Bun.which("node");
  if (!node) throw new Error("Node runtime required");
  const root = mkdtempSync(join(tmpdir(), "forge-mcp-stdout-"));
  try {
    mkdirSync(join(root, ".forge"));
    writeFileSync(join(root, ".forge/config.yaml"), config);
    const result = spawnSync(node, [resolve("dist/bin/forge.js"), ...args], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      input,
      env: {
        ...process.env,
        FORGE_DEVICE_ROOT: join(root, "device"),
        FORGE_SESSION: "mcp-stdout",
      },
    });
    expect(result.error).toBeUndefined();
    return result;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const mcp of [true, false])
  test(`bootstrap envelope in ${mcp ? "MCP stderr" : "CLI stdout"}`, () => {
    const result = run("{unclosed", mcp ? ["--mcp"] : ["issue", "list"]);
    expect(result.status).toBeGreaterThan(0);
    if (mcp) expect(result.stdout).toBe("");
    expect(JSON.parse(mcp ? result.stderr : result.stdout)).toMatchObject({
      ok: false,
      error: { code: expect.any(String) },
    });
  }, 60_000);

test("valid MCP session answers initialize and exits cleanly", () => {
  const params = {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "stdout", version: "1.0.0" },
  };
  const request = { jsonrpc: "2.0", id: 1, method: "initialize", params };
  const result = run("blocks: {}\n", ["--mcp"], JSON.stringify(request) + "\n");
  expect(result.status).toBe(0);
  for (const line of result.stdout.replace(/\r?\n$/, "").split("\n"))
    expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
}, 60_000);
