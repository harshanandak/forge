import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
    const sharedConsumer = process.env.DELIVERY_PACKED_CONSUMER;
    const consumer = sharedConsumer ?? join(work, "consumer");
    if (!sharedConsumer) {
      const npm = [
        join(dirname(node), "node_modules/npm/bin/npm-cli.js"),
        join(dirname(node), "../lib/node_modules/npm/bin/npm-cli.js"),
      ].find(existsSync);
      if (!npm) throw new Error("Node package installer required");
      if (!existsSync(join(root, "dist/src/assembly/templates.js")))
        run(process.execPath, ["run", "build"], root);
      const pack = JSON.parse(
        run(
          node,
          [
            npm,
            "pack",
            "--json",
            "--ignore-scripts",
            "--pack-destination",
            work,
          ],
          root,
        ),
      ) as { filename: string; files: { path: string }[] }[];
      expect(pack[0]!.files.map((f) => f.path)).toContain(
        "templates/delivery/skills/loop/SKILL.md",
      );
      mkdirSync(consumer);
      writeFileSync(
        join(consumer, "package.json"),
        '{"name":"delivery-consumer","private":true}',
      );
      run(
        node,
        [
          npm,
          "install",
          join(work, pack[0]!.filename),
          "--offline",
          "--no-audit",
          "--no-fund",
        ],
        consumer,
        180000,
      );
    }
    const installed = join(consumer, "node_modules/forge-workflow");
    expect(
      existsSync(join(installed, "templates/delivery/forge.template.json")),
    ).toBe(true);
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
