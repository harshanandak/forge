import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

for (const mode of [
  "honest:unknown",
  "honest:fail",
  "honest:missing",
  "honest:timeout",
  "honest:nothing",
  "no-head",
]) {
  test(`built CLI and MCP check outcomes: ${mode}`, () => {
    const root = resolve(import.meta.dirname, "../..");
    const node = Bun.which("node");
    if (!node) throw Error("Node runtime required");
    const result = spawnSync(
      node,
      [resolve(root, "test/node-fixtures/check/surfaces.mjs"), root, mode],
      { encoding: "utf8", timeout: 90000, windowsHide: true },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  }, 95000);
}
