import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runBounded } from "../../../tools/packed-pool.ts";
import { runFixtures } from "../../integration/fixtures/run.ts";
import { packedCoverage, selectShard } from "../state/counterfactuals.ts";
import { counterfactuals } from "./counterfactuals.ts";

const root = resolve(import.meta.dirname, "../../..");
const fixture = join(import.meta.dirname, "journeys.mjs");
const JOURNEYS = ["device", "fence", "levels", "policy", "move"] as const;

function timing(label: string, started: number): void {
  console.log(
    `Packed memory ${label}: ${Math.round(performance.now() - started)} ms`,
  );
}
function timed<T>(label: string, action: () => T): T {
  const started = performance.now();
  try {
    return action();
  } finally {
    timing(label, started);
  }
}
async function timedAsync<T>(
  label: string,
  action: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  try {
    return await action();
  } finally {
    timing(label, started);
  }
}
function run(command: string, args: string[], cwd = root): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  });
  if (result.status !== 0)
    throw new Error(
      `${command}: ${result.error?.message ?? result.stderr}\n${result.stdout}`,
    );
  return result.stdout;
}
function launch(command: string, args: string[], cwd: string) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (done, reject) => {
      const child = spawn(command, args, {
        cwd,
        windowsHide: true,
        timeout: 90_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let error: Error | undefined;
      child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
      child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
      child.once("error", (cause) => {
        error = cause;
      });
      child.once("close", (status) => {
        if (error) reject(error);
        else done({ status, stdout, stderr });
      });
    },
  );
}
function nodeBinary(): string {
  const node = Bun.which("node");
  if (!node) throw new Error("Node runtime required for packed integration");
  return node;
}
function pattern(text: string): RegExp {
  return new RegExp(
    text
      .split(/\s+/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+"),
  );
}

// Labelled integration: the packed, installed package on Node without Bun; each key journey is then
// shown to fail with its fix removed from the installed copy.
test("integration: packed memory journeys, each failing with its fix removed", async () => {
  const started = performance.now();
  const selected = selectShard(
    counterfactuals,
    packedCoverage(process.env.STATE_NODE_LEG).shard,
  );
  const sharedConsumer =
    process.env.MEMORY_PACKED_CONSUMER || process.env.FORGE_PACKED_CONSUMER;
  // Private copies remain below the consumer so dependencies resolve from its shared install.
  const work = mkdtempSync(
    join(sharedConsumer ?? tmpdir(), "forge-packed-memory-"),
  );
  try {
    const node = nodeBinary();
    // Pack smoke installs the package once and shares it; run alone, build, pack and install here.
    const consumer = sharedConsumer ?? work;
    if (!sharedConsumer) {
      timed("build", () => run(process.execPath, ["run", "build"]));
      const npm = [
        ...(process.env.FORGE_SMOKE_NPM_CLI
          ? [process.env.FORGE_SMOKE_NPM_CLI]
          : []),
        join(dirname(node), "node_modules/npm/bin/npm-cli.js"),
        join(dirname(node), "../lib/node_modules/npm/bin/npm-cli.js"),
      ].find((path) => existsSync(path));
      if (!npm)
        throw new Error("Cannot locate the Node installation's npm CLI");
      const packed = JSON.parse(
        timed("pack", () =>
          run(node, [
            npm,
            "pack",
            "--json",
            "--ignore-scripts",
            "--pack-destination",
            work,
          ]),
        ),
      ) as { filename: string }[];
      writeFileSync(
        join(consumer, "package.json"),
        '{"name":"memory-consumer","version":"1.0.0","private":true}',
      );
      timed("install", () =>
        run(
          node,
          [
            npm,
            "install",
            join(work, packed[0]!.filename),
            "--no-audit",
            "--no-fund",
          ],
          consumer,
        ),
      );
    } else {
      for (const phase of ["build", "pack", "install"])
        console.log(`Packed memory ${phase}: 0 ms (shared smoke)`);
    }
    const installed = join(consumer, "node_modules/forge-workflow");
    const positives = JOURNEYS.map((journey) => ({
      label: journey,
      command: node,
      args: [fixture, installed, journey],
      cwd: mkdtempSync(join(work, "positive-")),
      env: process.env,
    }));
    const passed = await timedAsync("positives", () =>
      runFixtures(positives, 3, "Packed memory"),
    );
    for (const [index, journey] of JOURNEYS.entries())
      expect(passed[index]).toContain(`PASS ${journey}`);

    // Each worker mutates its own copy; only its selected counterfactuals are sequential.
    const workers = timed("copy", () =>
      Array.from({ length: Math.min(2, selected.length) }, (_, worker) => {
        const cwd = join(work, `worker-${worker}`);
        const isolated = join(cwd, "node_modules/forge-memory-counterfactual");
        cpSync(installed, isolated, {
          recursive: true,
          filter: (path) => !path.endsWith(".map") && !path.endsWith(".ts"),
        });
        return {
          cwd,
          isolated,
          mutations: selected.filter((_, index) => index % 2 === worker),
        };
      }),
    );
    await timedAsync("mutations", async () => {
      // Drain every worker before removing any workspace, including on failure.
      await runBounded(workers, 2, async ({ cwd, isolated, mutations }) => {
        for (const mutation of mutations) {
          await timedAsync(
            `mutation ${mutation.journey}: ${mutation.evidence}`,
            async () => {
              const path = join(isolated, "dist/src", mutation.file);
              const original = readFileSync(path, "utf8");
              const find = pattern(mutation.from);
              expect(
                original,
                `${mutation.file} still contains ${mutation.from}`,
              ).toMatch(find);
              try {
                const changed = mutation.all
                  ? original.replace(new RegExp(find.source, "g"), mutation.to)
                  : original.replace(find, mutation.to);
                expect(changed).not.toBe(original);
                writeFileSync(path, changed);
                const result = await launch(
                  node,
                  [fixture, isolated, mutation.journey],
                  cwd,
                );
                if (result.status === 0)
                  throw new Error(
                    `Counterfactual survived: ${mutation.journey}: ${mutation.from}\n${result.stdout}`,
                  );
                expect(result.stderr).toContain(mutation.evidence);
              } finally {
                writeFileSync(path, original);
              }
            },
          );
        }
      });
    });
    console.log(
      `Packed memory: ${JOURNEYS.length} journeys, ${selected.length}/${counterfactuals.length} remove-the-fix checks`,
    );
  } finally {
    try {
      timed("cleanup", () => rmSync(work, { recursive: true, force: true }));
    } finally {
      timing("total", started);
    }
  }
}, 420_000);
