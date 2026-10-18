import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("integration: unknown filesystems open with one warning on Node and Bun", () => {
  const node = Bun.which("node");
  if (!node) throw new Error("Node runtime required");
  const fixture = fileURLToPath(
    new URL(
      "../../node-fixtures/state/filesystem-unknown.mjs",
      import.meta.url,
    ),
  );
  for (const runtime of [node, process.execPath]) {
    const result = spawnSync(runtime, [fixture], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(
      result.stderr.match(/Store filesystem warning: unknown/g),
    ).toHaveLength(1);
    expect(result.stdout).toBe("");
  }
}, 30000);
