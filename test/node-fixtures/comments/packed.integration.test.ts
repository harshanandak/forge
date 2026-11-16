import { expect, test } from "bun:test";
import {
  execFileSync,
  spawnSync,
  type SpawnSyncReturns,
} from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { packedConsumer } from "../../integration/packed-consumer.ts";

test("the installed Node checker includes its parser and refuses a new comment", () => {
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
    const run = (): SpawnSyncReturns<string> =>
      spawnSync(
        "node",
        [
          "--input-type=module",
          "--eval",
          `import { main } from 'forge-workflow/checks/no-comments'; process.chdir(${JSON.stringify(root)}); main(['--base', 'baseline']);`,
        ],
        {
          cwd: packedConsumer(),
          encoding: "utf8",
          windowsHide: true,
          timeout: 30_000,
        },
      );
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
