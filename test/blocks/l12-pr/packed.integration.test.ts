import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import {
  packedCoverage,
  selectShard,
} from "../../node-fixtures/state/counterfactuals.ts";
import { counterfactuals } from "../../node-fixtures/l12-pr/counterfactuals.ts";
const root = resolve(import.meta.dirname, "../../..");
function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
) {
  return spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120000,
  });
}
function good(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): string {
  const result = run(command, args, cwd, env);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return result.stdout;
}
test("installed PR/GitHub blocks: all computed verdicts, exact head and both fenced merge barriers", () => {
  const shared = process.env.FORGE_PACKED_CONSUMER;
  const work = mkdtempSync(
    join(shared ?? tmpdir(), shared ? "pr-" : "forge-pr-packed-"),
  );
  try {
    const node = Bun.which("node");
    if (!node) throw new Error("Node is required");
    const consumer = shared ? work : join(work, "consumer");
    if (!shared) mkdirSync(consumer);
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({
        name: "pr-packed-consumer",
        version: "1.0.0",
        private: true,
        type: "module",
      }),
    );
    const env = { ...process.env };
    const path =
      Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
    env[path] = (env[path] ?? "")
      .split(delimiter)
      .filter(
        (dir) =>
          !["bun", "bun.exe", "bun.cmd", "bunx", "bunx.exe"].some((file) =>
            existsSync(join(dir, file)),
          ),
      )
      .join(delimiter);
    delete env.BUN_INSTALL;
    if (!shared) {
      good(process.execPath, ["run", "build"], root, process.env);
      const npm = [
        process.env.FORGE_SMOKE_NPM_CLI,
        join(dirname(node), "node_modules/npm/bin/npm-cli.js"),
        join(dirname(node), "../lib/node_modules/npm/bin/npm-cli.js"),
      ].find((value): value is string => Boolean(value) && existsSync(value!));
      if (!npm) throw new Error("npm CLI is required");
      const packed = JSON.parse(
        good(
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
          env,
        ),
      ) as { filename: string }[];
      good(
        node,
        [
          npm,
          "install",
          join(work, packed[0]!.filename),
          "--no-audit",
          "--no-fund",
          "--ignore-scripts",
        ],
        consumer,
        env,
      );
    }
    const installed = join(shared ?? consumer, "node_modules/forge-workflow");
    const journey = join(root, "test/node-fixtures/l12-pr/journeys.mjs"),
      provider = join(root, "test/node-fixtures/l12-pr/provider.mjs");
    const nodes = [
      ...new Set(
        [node, process.env.FORGE_NODE26].filter((value): value is string =>
          Boolean(value),
        ),
      ),
    ];
    for (const [index, runtime] of nodes.entries()) {
      const output = good(
        runtime,
        [journey, installed, join(work, `journey-${index}`), "all", provider],
        consumer,
        env,
      );
      expect(output).toContain("PR journey all: passed");
      console.log(output.trim());
      const assembly = good(
        runtime,
        [
          join(root, "test/node-fixtures/l12-pr/assembly.mjs"),
          installed,
          join(work, `assembly-${index}`),
        ],
        consumer,
        env,
      );
      expect(assembly).toContain("state.sqlite before=false, after=false");
      console.log(assembly.trim());
    }
    const isolated = join(consumer, "node_modules/forge-pr-counterfactual");
    cpSync(installed, isolated, {
      recursive: true,
      filter: (path) => !path.endsWith(".map"),
    });
    const selected = selectShard(
      counterfactuals,
      packedCoverage(process.env.STATE_NODE_LEG).shard,
    );
    for (const [index, mutation] of selected.entries()) {
      const target = join(isolated, "dist/src", mutation.file),
        original = readFileSync(target, "utf8");
      expect(original).toContain(mutation.from);
      try {
        writeFileSync(target, original.replace(mutation.from, mutation.to));
        const result = run(
          node,
          [
            journey,
            isolated,
            join(work, `mutation-${index}`),
            mutation.journey,
            provider,
          ],
          consumer,
          env,
        );
        expect(result.status, result.stdout + result.stderr).not.toBe(0);
        expect(result.stderr).toContain(mutation.evidence);
      } finally {
        writeFileSync(target, original);
      }
    }
    console.log(
      `Packed PR/GitHub: ${nodes.length} Node runtimes; ${selected.length} remove-the-fix journeys`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 180000);
