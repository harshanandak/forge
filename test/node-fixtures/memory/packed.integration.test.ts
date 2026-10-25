import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { runBounded, runFixtures } from "../../integration/fixtures/run.ts";
import { packedConsumer } from "../../integration/packed-consumer.ts";
import { packedCoverage, selectShard } from "../state/counterfactuals.ts";
import { counterfactuals } from "./counterfactuals.ts";

const fixture = join(import.meta.dirname, "journeys.mjs");
const JOURNEYS = ["device", "anywhere", "fence", "levels"] as const;

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
  const consumer = packedConsumer();
  // Private copies remain below the consumer so dependencies resolve from its shared install.
  const work = mkdtempSync(join(consumer, "forge-packed-memory-"));
  try {
    const node = nodeBinary();
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
    for (const [index, journey] of JOURNEYS.entries()) {
      expect(passed[index]).toContain(`PASS ${journey}`);
      for (const line of passed[index]!.split(/\r?\n/))
        if (line.startsWith("STEP ")) console.log(`Packed memory ${line}`);
    }

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
