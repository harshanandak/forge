import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { packedConsumer } from "../packed-consumer.ts";
import { environmentWithoutBun } from "../../../tools/pack-smoke/environment.ts";

test("the installed guide runs the shipped block and explains three manifest mistakes", () => {
  const scratch = mkdtempSync(join(tmpdir(), "forge-author-"));
  try {
    const node = Bun.which("node");
    if (!node) throw new Error("Node runtime required");
    const env = environmentWithoutBun(join(scratch, "bin"), node);
    const result = spawnSync(
      node,
      [resolve(import.meta.dirname, "journey.mjs"), packedConsumer()],
      {
        cwd: scratch,
        env,
        encoding: "utf8",
        windowsHide: true,
        timeout: 120_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    console.log(result.stdout.trim());
    expect(result.stdout).toContain("CUSTOM_BLOCK_JOURNEY_PASS");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 150_000);
