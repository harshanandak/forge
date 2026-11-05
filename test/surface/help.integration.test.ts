import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { environmentWithoutBun } from "../../tools/pack-smoke/environment.ts";
import { cleanupAttribution } from "../tools/cleanup-attribution.ts";
import { FixtureChildren } from "../fixture-children.ts";

test("built CLI help alias matches --help on Node without Bun or stores", async () => {
  const children = new FixtureChildren();
  const root = mkdtempSync(join(tmpdir(), "forge-help-alias-"));
  const node = Bun.which("node");
  if (!node) throw new Error("Node runtime required");
  try {
    const bin = join(root, "bin");
    const env = {
      ...environmentWithoutBun(bin, node),
      FORGE_DEVICE_ROOT: join(root, "device"),
    };
    const run = (args: string[]) =>
      children.run(
        join(bin, process.platform === "win32" ? "node.exe" : "node"),
        [resolve("dist/bin/forge.js"), ...args],
        {
          cwd: root,
          env,
          windowsHide: true,
          timeout: 30_000,
        },
      );
    expect(spawnSync("bun", ["--version"], { env }).error).toBeDefined();
    for (const args of [
      [],
      ["catalog"],
      ["catalog", "list"],
      ["catalog.list"],
      ["missing"],
      ["catalog", "--json"],
    ]) {
      const expected = await run([...args, "--help"]);
      const actual = await run(["help", ...args]);
      expect(expected.error).toBeUndefined();
      expect(expected.status).toBe(0);
      expect(actual.error).toBeUndefined();
      expect(actual.status).toBe(0);
      expect(actual.stdout).toBe(expected.stdout);
      expect(actual.stderr).toBe("");
    }
    expect(readdirSync(root)).toEqual(["bin"]);
  } finally {
    await children.cleanup(() =>
      cleanupAttribution(root, () =>
        rmSync(root, { recursive: true, force: true }),
      ),
    );
  }
}, 60_000);
