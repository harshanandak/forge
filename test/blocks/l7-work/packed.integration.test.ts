import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { counterfactuals } from "../../node-fixtures/work/counterfactuals.ts";
import {
  packedCoverage,
  selectShard,
} from "../../node-fixtures/state/counterfactuals.ts";
import { runFixtures } from "../../integration/fixtures/run.ts";
import { packedConsumer } from "../../integration/packed-consumer.ts";

const root = resolve(import.meta.dirname, "../../..");
function timed<T>(label: string, action: () => T): T {
  const started = performance.now();
  try {
    return action();
  } finally {
    console.log(
      `Packed work ${label}: ${Math.round(performance.now() - started)} ms`,
    );
  }
}
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
test("installed work block: CLI readback, lease fixtures and remove-the-fix checks", async () => {
  const started = performance.now();
  const consumer = packedConsumer();
  // Keep mutable roots short and private; ancestor lookup reuses installed
  // dependencies without copying or modifying the smoke's base package.
  const work = mkdtempSync(join(consumer, "fw-"));
  try {
    const node = Bun.which("node");
    if (!node) throw new Error("Node is required");
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
    const positives = runtimes.flatMap((runtime) =>
      [
        {
          name: "journeys",
          file: journey,
          expected: [
            "PASS records",
            "PASS leases",
            "PASS dependencies",
            "PASS dependency-race",
            "PASS append-order",
          ],
        },
        {
          name: "graph",
          file: join(root, "test/node-fixtures/work/graph.mjs"),
          expected: ["PASS graph:"],
        },
        ...(nodes.includes(runtime)
          ? [
              {
                name: "CLI",
                file: join(root, "test/node-fixtures/work/cli.mjs"),
                expected: ["PASS installed CLI"],
              },
            ]
          : []),
      ].map((fixture) => {
        const cwd = mkdtempSync(join(work, "p-"));
        return {
          ...fixture,
          label: `${fixture.name} (${runtime})`,
          command: runtime,
          args: [fixture.file, installed, cwd, "all"],
          cwd,
          env: fixture.name === "CLI" ? env : process.env,
        };
      }),
    );
    const positiveStarted = performance.now();
    try {
      // Drain every child before cleanup removes its private state/project root.
      const outputs = await runFixtures(positives, 2, "Packed work");
      for (const [index, output] of outputs.entries()) {
        for (const expected of positives[index]!.expected)
          expect(output).toContain(expected);
        console.log(output.trim());
      }
    } finally {
      console.log(
        `Packed work positive fixtures: ${Math.round(performance.now() - positiveStarted)} ms`,
      );
    }
    const isolated = join(work, "cf");
    timed("copy", () =>
      cpSync(installed, isolated, {
        recursive: true,
        filter: (path) => !path.endsWith(".map"),
      }),
    );
    const selected = selectShard(counterfactuals, coverage.shard);
    timed("mutations", () => {
      for (const [index, mutation] of selected.entries()) {
        const target = join(isolated, "dist/src", mutation.file);
        const original = readFileSync(target, "utf8");
        expect(original).toContain(mutation.from);
        try {
          writeFileSync(target, original.replace(mutation.from, mutation.to));
          const result = timed(
            `mutation ${index + 1} ${mutation.journey}`,
            () =>
              run(
                node,
                [
                  mutation.journey === "graph"
                    ? join(root, "test/node-fixtures/work/graph.mjs")
                    : journey,
                  isolated,
                  join(work, `mutation-${index}`),
                  mutation.journey,
                ],
                work,
              ),
          );
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain(mutation.evidence);
        } finally {
          writeFileSync(target, original);
        }
      }
    });
    console.log(
      `Packed work: ${nodes.length} Node runtimes, ${runtimes.length} lease runtimes, ${selected.length}/${counterfactuals.length} counterfactuals`,
    );
  } finally {
    try {
      timed("cleanup", () => rmSync(work, { recursive: true, force: true }));
    } finally {
      console.log(
        `Packed work total: ${Math.round(performance.now() - started)} ms`,
      );
    }
  }
}, 120000);
