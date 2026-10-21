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
import { delimiter, dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
function run(
  executable: string,
  args: string[],
  cwd: string,
  timeout = 120000,
  env = process.env,
): string {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout,
    env,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${result.error?.message ?? "command failed"}\n${result.stdout}\n${result.stderr}`,
    );
  return result.stdout;
}

test("a new user's first run works end to end from the packed package", () => {
  const work = mkdtempSync(join(tmpdir(), "forge-first-run-"));
  try {
    const node = Bun.which("node");
    if (!node) throw new Error("Node runtime required");
    // Pack smoke shares its one npm install; standalone runs pack and install once here.
    const sharedConsumer = process.env.FIRST_RUN_PACKED_CONSUMER;
    const consumer = sharedConsumer ?? join(work, "consumer");
    if (!sharedConsumer) {
      const npm = [
        join(dirname(node), "node_modules/npm/bin/npm-cli.js"),
        join(dirname(node), "../lib/node_modules/npm/bin/npm-cli.js"),
      ].find(existsSync);
      if (!npm) throw new Error("Node package installer required");
      if (!existsSync(join(root, "dist/bin/forge.js")))
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
      ) as { filename: string }[];
      mkdirSync(consumer);
      writeFileSync(
        join(consumer, "package.json"),
        '{"name":"first-run-consumer","private":true}',
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
    // The journey runs as a Node-only user: no Bun on PATH.
    const env = { ...process.env };
    const pathKey =
      Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
    env[pathKey] = (env[pathKey] ?? "")
      .split(delimiter)
      .filter(
        (directory) =>
          !["bun", "bun.exe", "bunx", "bunx.exe"].some((name) =>
            existsSync(join(directory, name)),
          ),
      )
      .join(delimiter);
    delete env.BUN_INSTALL;
    expect(
      spawnSync("bun", ["--version"], { env, windowsHide: true }).error,
    ).toBeDefined();
    const projects = mkdtempSync(join(work, "projects-"));
    const report = run(
      node,
      [
        join(root, "test/node-fixtures/first-run/journey.mjs"),
        join(consumer, "node_modules/forge-workflow"),
      ],
      projects,
      120000,
      env,
    ).trim();
    console.log(report);
    expect(report).toEndWith(
      "template import → skills sync → issue create → issue claim → check red → check green → pr create + issue link → merge by head → issue close + show",
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 300_000);
