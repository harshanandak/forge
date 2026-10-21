import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { packedConsumer } from "../../integration/packed-consumer.ts";

const root = resolve(import.meta.dirname, "../../..");
function run(
  executable: string,
  args: string[],
  cwd: string,
  timeout = 120000,
): string {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${result.error?.message ?? "command failed"}\n${result.stdout}\n${result.stderr}`,
    );
  return result.stdout;
}

test("the delivery template ships in the npm package and runs the project's own npm test", () => {
  const work = mkdtempSync(join(tmpdir(), "forge-packed-delivery-"));
  try {
    const node = Bun.which("node");
    if (!node) throw new Error("Node runtime required");
    const installed = join(packedConsumer(), "node_modules/forge-workflow");
    for (const file of ["forge.template.json", "skills/loop/SKILL.md"])
      expect(existsSync(join(installed, "templates/delivery", file))).toBe(
        true,
      );
    // The journey's projects live in a private directory, never in the shared install.
    const projects = mkdtempSync(join(work, "projects-"));
    console.log(
      run(
        node,
        [join(root, "test/node-fixtures/templates/delivery.mjs"), installed],
        projects,
      ).trim(),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 300_000);
