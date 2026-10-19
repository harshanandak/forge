import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { counterfactuals } from "../../node-fixtures/work/counterfactuals.ts";
import {
  packedCoverage,
  selectShard,
} from "../../node-fixtures/state/counterfactuals.ts";
const root = resolve(import.meta.dirname, "../../..");
function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  return spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 90000,
  });
}
function good(
  command: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): string {
  const result = run(command, args, cwd, env);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return result.stdout;
}
test("installed work block: CLI readback, lease fixtures and remove-the-fix checks", () => {
  const work = mkdtempSync(join(tmpdir(), "forge-packed-work-"));
  try {
    good(process.execPath, ["run", "build"], root);
    const node = Bun.which("node");
    if (!node) throw new Error("Node is required");
    const npm = [
      join(dirname(node), "node_modules/npm/bin/npm-cli.js"),
      join(dirname(node), "../lib/node_modules/npm/bin/npm-cli.js"),
    ].find(existsSync);
    if (!npm) throw new Error("npm CLI is required");
    const packed = JSON.parse(
      good(node, [npm, "pack", "--json", "--pack-destination", work], root),
    ) as { filename: string }[];
    const consumer = join(work, "consumer");
    mkdirSync(consumer);
    writeFileSync(
      join(consumer, "package.json"),
      '{"name":"packed-work-consumer","version":"1.0.0","private":true}',
    );
    good(
      node,
      [
        npm,
        "install",
        join(work, packed[0]!.filename),
        "--no-audit",
        "--no-fund",
      ],
      consumer,
    );
    const installed = join(consumer, "node_modules/forge-workflow");
    const env = { ...process.env };
    const path =
      Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
    env[path] = (env[path] ?? "")
      .split(delimiter)
      .filter(
        (dir) =>
          !["bun", "bun.exe", "bun.cmd", "bunx", "bunx.exe"].some((name) =>
            existsSync(join(dir, name)),
          ),
      )
      .join(delimiter);
    delete env.BUN_INSTALL;
    const coverage = packedCoverage(process.env.STATE_NODE_LEG);
    const nodes = [
      ...new Set(
        [node, process.env.FORGE_NODE26].filter((value): value is string =>
          Boolean(value),
        ),
      ),
    ];
    const runtimes = [...nodes, ...(coverage.bun ? [process.execPath] : [])];
    const journey = join(root, "test/node-fixtures/work/journeys.mjs");
    for (const [index, runtime] of runtimes.entries()) {
      const output = good(
        runtime,
        [journey, installed, join(work, `journey-${index}`), "all"],
        consumer,
      );
      expect(output).toContain("PASS records");
      expect(output).toContain("PASS leases");
      expect(output).toContain("PASS dependencies");
      expect(output).toContain("PASS dependency-race");
      expect(output).toContain("PASS append-order");
      const graph = good(
        runtime,
        [join(root, "test/node-fixtures/work/graph.mjs"), installed],
        consumer,
      );
      expect(graph).toContain("PASS graph:");
      console.log(graph.trim());
    }
    for (const [index, runtime] of nodes.entries())
      expect(
        good(
          runtime,
          [
            join(root, "test/node-fixtures/work/cli.mjs"),
            installed,
            join(consumer, `project-${index}`),
          ],
          consumer,
          env,
        ),
      ).toContain("PASS installed CLI");
    const isolated = join(consumer, "node_modules/forge-work-counterfactual");
    cpSync(installed, isolated, {
      recursive: true,
      filter: (path) => !path.endsWith(".map"),
    });
    const selected = selectShard(counterfactuals, coverage.shard);
    for (const [index, mutation] of selected.entries()) {
      const target = join(isolated, "dist/src", mutation.file);
      const original = readFileSync(target, "utf8");
      expect(original).toContain(mutation.from);
      try {
        writeFileSync(target, original.replace(mutation.from, mutation.to));
        const result = run(
          node,
          [
            mutation.journey === "graph"
              ? join(root, "test/node-fixtures/work/graph.mjs")
              : journey,
            isolated,
            join(work, `mutation-${index}`),
            mutation.journey,
          ],
          consumer,
        );
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(mutation.evidence);
      } finally {
        writeFileSync(target, original);
      }
    }
    console.log(
      `Packed work: ${nodes.length} Node runtimes, ${runtimes.length} lease runtimes, ${selected.length} counterfactuals`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 120000);
