// [integration] Run the real Bun test process and real ecosystem fixture; no package publication.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

for (const strict of [false, true])
  test(`missing ecosystem tools ${strict ? "refuse release" : "remain named developer skips"}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-release-tools-"));
    try {
      const node = Bun.which("node");
      if (!node) throw new Error("Node required");
      const module = pathToFileURL(
        resolve(
          import.meta.dirname,
          "../../node-fixtures/check/ecosystems.mjs",
        ),
      ).href;
      const script = `import {ecosystems} from ${JSON.stringify(module)};
        console.log(JSON.stringify(await ecosystems({directory:${JSON.stringify(dir)},services:{environment:{},process:{resolve:()=>({kind:'unavailable',reason:'fixture tool absent'})}}})));`;
      const out = spawnSync(node, ["--input-type=module", "-e", script], {
        env: {
          ...process.env,
          NODE_PATH: "",
          CHECK_ECOSYSTEM_TOOLS: join(dir, "empty-tools"),
          CHECK_PYTHON_PACKAGES: join(dir, "empty-python"),
          FORGE_RELEASE_ACCEPTANCE: strict ? "1" : "",
        },
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      });
      expect(out.error).toBeUndefined();
      expect(out.status === 0, out.stderr).toBe(!strict);
      if (strict)
        expect(out.stderr).toContain("release requires every ecosystem");
      else
        expect(
          (JSON.parse(out.stdout) as { skipped: string[] }).skipped,
        ).toHaveLength(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

for (const mode of ["pass", "failed", "skipped", "omitted"]) {
  test(`release journey runner rejects ${mode} with missing required inventory`, () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-release-journey-"));
    try {
      const node = Bun.which("node");
      if (!node) throw new Error("Node required");
      mkdirSync(join(dir, "test"));
      if (mode !== "omitted")
        writeFileSync(
          join(dir, "test/packed.integration.test.ts"),
          `import {test,expect} from 'bun:test'; test${mode === "skipped" ? ".skip" : ""}('installed journey',()=>expect(${mode !== "failed"}).toBe(true),1000);`,
        );
      const out = spawnSync(
        node,
        [
          resolve(import.meta.dirname, "../../../tools/release/journeys.mjs"),
          dir,
          dir,
          join(dir, "candidate.tgz"),
        ],
        {
          encoding: "utf8",
          timeout: 20_000,
          windowsHide: true,
        },
      );
      expect(out.error).toBeUndefined();
      expect(out.status === 0, out.stderr).toBe(false);
      if (mode === "skipped")
        expect(out.stderr).toContain("release journey skipped");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 25_000);
}
