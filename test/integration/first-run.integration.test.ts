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

const root = resolve(import.meta.dirname, "../..");
function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  timeout = 120000,
): string {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${result.error?.message ?? "process failed"}\n${result.stdout}\n${result.stderr}`,
    );
  return result.stdout;
}

test("first run from the packed package: config show, check run, pr status, pr merge", () => {
  const node = Bun.which("node");
  if (!node) throw new Error("Node is required");
  const work = mkdtempSync(join(tmpdir(), "forge-first-run-pack-"));
  try {
    // Pack smoke shares its npm install; a standalone run packs and installs once.
    let consumer = process.env.FIRST_RUN_PACKED_CONSUMER;
    if (!consumer) {
      consumer = join(work, "consumer");
      const npm = [
        join(dirname(node), "node_modules/npm/bin/npm-cli.js"),
        join(dirname(node), "../lib/node_modules/npm/bin/npm-cli.js"),
      ].find(existsSync);
      if (!npm) throw new Error("npm CLI is required");
      run(process.execPath, ["run", "build"], root);
      const [packed] = JSON.parse(
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
        '{"name":"first-run","private":true}',
      );
      run(
        node,
        [
          npm,
          "install",
          join(work, packed!.filename),
          "--no-audit",
          "--no-fund",
          "--prefer-offline",
        ],
        consumer,
      );
    }
    const env = { ...process.env };
    const pathKey =
      Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
    env[pathKey] = (env[pathKey] ?? "")
      .split(delimiter)
      .filter(
        (dir) =>
          !["bun", "bun.exe", "bun.cmd", "bunx", "bunx.exe"].some((name) =>
            existsSync(join(dir, name)),
          ),
      )
      .join(delimiter);
    delete env.BUN_INSTALL;
    expect(
      spawnSync("bun", ["--version"], { env, windowsHide: true }).error,
    ).toBeDefined();

    const started = performance.now();
    const output = run(
      node,
      [
        join(root, "test/node-fixtures/first-run/journey.mjs"),
        join(consumer, "node_modules/forge-workflow"),
      ],
      consumer,
      env,
    );
    console.log(output.trim());
    console.log(
      `First-run journey: ${Math.round(performance.now() - started)} ms`,
    );
    for (const step of ["config show", "check run", "pr status", "pr merge"])
      expect(output).toContain(`PASS ${step}:`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 240000);
