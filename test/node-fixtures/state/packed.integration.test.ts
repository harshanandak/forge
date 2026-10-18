import { test, expect } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import {
  counterfactuals,
  packedCoverage,
  selectShard,
} from "./counterfactuals.ts";

const root = resolve(import.meta.dirname, "../../..");
const fixture = join(import.meta.dirname, "journeys.mjs");
function run(command: string, args: string[], cwd = root): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 90000,
  });
  if (result.status !== 0)
    throw new Error(
      `${command}: ${result.error?.message ?? result.stderr}\n${result.stdout}`,
    );
  return result.stdout;
}

function launch(command: string, args: string[], cwd: string, timeout = 30000) {
  return new Promise<{
    status: number | null;
    signal: NodeJS.Signals | null;
    error: Error | undefined;
    stdout: string;
    stderr: string;
  }>((resolve) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let error: Error | undefined;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (cause) => {
      error = cause;
    });
    child.on("close", (status, signal) => {
      resolve({ status, signal, error, stdout, stderr });
    });
  });
}

// Drain every child before restoring package files or removing its working directory.
async function complete(tasks: Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(tasks);
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  );
  if (failures.length) throw new AggregateError(failures);
}

// Labelled integration: real package install and separate runtime processes, no developer checkout imports.
test("integration: packed state journeys and targeted remove-the-fix checks", async () => {
  const coverage = packedCoverage(process.env.STATE_NODE_LEG);
  let started = performance.now();
  function phase(name: string) {
    console.log(
      `Packed state ${name}: ${Math.round(performance.now() - started)} ms`,
    );
    started = performance.now();
  }
  const work = mkdtempSync(join(tmpdir(), "forge-packed-state-"));
  try {
    const node = Bun.which("node");
    if (!node) throw new Error("Node runtime required for packed integration");
    // The smoke owns a real npm install until this test process has finished.
    const consumer =
      process.env.STATE_PACKED_CONSUMER ?? join(work, "consumer");
    if (!process.env.STATE_PACKED_CONSUMER) {
      run(process.execPath, ["run", "build"]);
      const npm = [
        join(dirname(node), "node_modules/npm/bin/npm-cli.js"),
        join(dirname(node), "../lib/node_modules/npm/bin/npm-cli.js"),
      ].find((path) => existsSync(path));
      if (!npm)
        throw new Error("Cannot locate the Node installation's npm CLI");
      const pack = JSON.parse(
        run(node, [npm, "pack", "--json", "--pack-destination", work]),
      ) as { filename: string }[];
      mkdirSync(consumer);
      writeFileSync(
        join(consumer, "package.json"),
        '{"name":"state-consumer","version":"1.0.0","private":true}',
      );
      run(
        node,
        [
          npm,
          "install",
          join(work, pack[0]!.filename),
          "--no-audit",
          "--no-fund",
        ],
        consumer,
      );
    }
    const installed = join(consumer, "node_modules/forge-workflow");
    phase("install");
    const runtimes = [
      ...new Set(
        [
          node,
          ...(coverage.bun ? [process.execPath] : []),
          ...(coverage.shard === undefined ? [process.env.STATE_NODE26] : []),
        ].filter((value): value is string => Boolean(value)),
      ),
    ];
    await complete(
      runtimes.map(async (runtime) => {
        const result = await launch(
          runtime,
          [fixture, installed],
          consumer,
          90000,
        );
        if (result.error || result.status !== 0)
          throw new Error(
            `${runtime}: ${result.error?.message ?? result.stderr}\n${result.stdout}`,
          );
        const report = JSON.parse(result.stdout) as {
          passed: string[];
          runtime: string;
          binding: string;
        };
        expect(report.passed).toHaveLength(20);
        expect(report.binding).toBe(
          runtime === process.execPath ? "bun:sqlite" : "node:sqlite",
        );
        if (runtime !== process.execPath && process.env.STATE_NODE_LEG)
          expect(report.runtime.split(".")[0]).toBe(
            `v${process.env.STATE_NODE_LEG}`,
          );
      }),
    );
    phase("journeys");
    const nodeMutations = selectShard(counterfactuals, coverage.shard);
    const scheduled = counterfactuals
      .map((mutation) => ({
        mutation,
        runtimes: runtimes.filter(
          (runtime) =>
            runtime === process.execPath || nodeMutations.includes(mutation),
        ),
      }))
      .filter((entry) => entry.runtimes.length > 0);
    // Each worker mutates its own package copy. Fixtures already create private stores;
    // runtime processes may share a read-only copy, but concurrent mutations must not.
    await complete(
      Array.from({ length: 4 }, async (_, worker) => {
        const isolated = join(
          consumer,
          "node_modules",
          `forge-counterfactual-${worker}`,
        );
        cpSync(installed, isolated, {
          recursive: true,
          filter: (path) => !path.endsWith(".map") && !path.endsWith(".ts"),
        });
        for (const { mutation, runtimes: mutationRuntimes } of scheduled.filter(
          (_, index) => index % 4 === worker,
        )) {
          const path = join(isolated, "dist/src", mutation.file);
          const original = readFileSync(path, "utf8");
          const pattern = new RegExp(
            mutation.from
              .split(/\s+/)
              .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
              .join("\\s+"),
          );
          expect(original).toMatch(pattern);
          try {
            writeFileSync(path, original.replace(pattern, mutation.to));
            await complete(
              mutationRuntimes.map(async (runtime) => {
                const result = await launch(
                  runtime,
                  [fixture, isolated, mutation.journey],
                  consumer,
                  mutation.kind === "timeout" ? mutation.timeout : 30000,
                );
                expect(result.error).toBeUndefined();
                if (mutation.kind === "timeout") {
                  expect(result.status).toBeNull();
                  expect(result.signal).toBe("SIGTERM");
                  return;
                }
                if (result.status !== 1)
                  throw new Error(
                    `Counterfactual survived: ${mutation.journey}: ${mutation.from} (${runtime})\n${result.stdout}\n${result.stderr}`,
                  );
                if (mutation.from === "if (lstatSync(path).isSymbolicLink())")
                  expect(result.stderr).toMatch(
                    /dangling file symlink must be refused|Dangling store symlink/,
                  );
                else expect(result.stderr).toContain(mutation.evidence);
              }),
            );
          } finally {
            writeFileSync(path, original);
          }
        }
      }),
    );
    phase("counterfactuals");
    for (const runtime of runtimes)
      console.log(
        `Packed state ${runtime === process.execPath ? "Bun" : "Node"}: 20 journeys, ${runtime === process.execPath ? counterfactuals.length : nodeMutations.length}/${counterfactuals.length} counterfactuals`,
      );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 240000);
