import { expect, test } from "bun:test";
import {
  execFileSync,
  spawnSync,
  type SpawnSyncReturns,
} from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { requireJourneyEnv } from "../../integration/journey-env.ts";
import { packedConsumer } from "../../integration/packed-consumer.ts";

test("the installed check adds no parser dependency and runs the selected lint runtime", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-packed-comments-"));
  const git = (...args: string[]): string =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      stdio: "pipe",
    }).trim();
  try {
    git("init", "-q");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    writeFileSync(join(root, "value.ts"), "export const value = 1;\n");
    git("add", ".");
    git("commit", "-qm", "base");
    git("branch", "baseline");
    const lint = requireJourneyEnv(
      "FORGE_LINT_BUN",
      "FORGE_LINT_BUN must select the CI canary",
    );
    const pkg = JSON.parse(
      readFileSync(
        join(packedConsumer(), "node_modules/forge-workflow/package.json"),
        "utf8",
      ),
    ) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      "@modelcontextprotocol/server",
      "koffi",
      "yaml",
    ]);
    const run = (runtime = lint): SpawnSyncReturns<string> =>
      spawnSync(
        "node",
        [
          "--input-type=module",
          "--eval",
          `import plugin, { main } from 'forge-workflow/checks/no-comments'; if (!plugin.rules['no-comments']) throw new Error('Missing rule'); process.chdir(${JSON.stringify(root)}); main(['--base', 'baseline', '--bun', ${JSON.stringify(runtime)}]);`,
        ],
        {
          cwd: packedConsumer(),
          encoding: "utf8",
          windowsHide: true,
          timeout: 30_000,
        },
      );
    const unavailable = run(join(root, "missing-bun"));
    expect(unavailable.status).toBe(2);
    expect(JSON.parse(unavailable.stdout)).toMatchObject({
      status: "INCOMPLETE",
    });
    const clean = run();
    expect(clean.status).toBe(0);
    expect(JSON.parse(clean.stdout)).toMatchObject({
      status: "PASS",
      violations: [],
    });
    writeFileSync(join(root, "value.ts"), "export const value = 2; // added\n");
    git("add", ".");
    git("commit", "-qm", "comment");
    const refused = run();
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("value.ts:1: new line comment");
    expect(JSON.parse(refused.stdout)).toMatchObject({
      status: "FAIL",
      violations: [{ file: "value.ts", line: 1, kind: "line comment" }],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
