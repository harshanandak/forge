import { expect, test } from "bun:test";
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
import { runChild } from "../../../tools/child-runner.ts";
import { runBounded } from "../../../tools/packed-pool.ts";
import { inheritRunnerGroup } from "../../../tools/runner-policy.ts";
import { runFixtures } from "../../integration/fixtures/run.ts";
import { counterfactuals } from "../../node-fixtures/l12-git/counterfactuals.ts";
import {
  packedCoverage,
  selectShard,
} from "../../node-fixtures/state/counterfactuals.ts";

const root = resolve(import.meta.dirname, "../../..");
const journeys = [
  "base",
  "unstarted",
  "merge",
  "squash",
  "push",
  "removal-race",
  "hook-recovery",
  "hooks",
  "churn",
  "capacity",
  "rewritten-default",
  "failed-create",
  "failed-create-process",
  "reconcile-absent",
  "reconcile-adopt",
  "reconcile-live",
  "squash-dryrun",
  "squash-no-author",
] as const;
function timing(label: string, started: number): void {
  console.log(
    `Packed Git ${label}: ${Math.round(performance.now() - started)} ms`,
  );
}
async function timed<T>(label: string, action: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await action();
  } finally {
    timing(label, started);
  }
}
async function good(
  label: string,
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<string> {
  const result = await runChild(label, command, args, {
    cwd,
    env: process.env,
    inheritProcessGroup: inheritRunnerGroup(),
    timeoutMs: 180000,
    cleanupTimeoutMs: 5000,
    maxOutputBytes: 1048576,
    onOutput: () => undefined,
  });
  return result.stdout;
}

test("installed git block: real clone journeys and remove-the-fix checks", async () => {
  const started = performance.now();
  const sharedConsumer =
    process.env.GIT_PACKED_CONSUMER || process.env.FORGE_PACKED_CONSUMER;
  const work = mkdtempSync(join(sharedConsumer ?? tmpdir(), "git-"));
  try {
    const node = Bun.which("node");
    if (!node) throw new Error("Node is required");
    const consumer = sharedConsumer ?? work;
    if (sharedConsumer) {
      for (const phase of ["build", "pack", "install"])
        console.log(`Packed Git ${phase}: 0 ms (reused smoke consumer)`);
    } else {
      await timed("build", () =>
        good("Git build", process.execPath, ["run", "build"], root),
      );
      const npm = [
        ...(process.env.FORGE_SMOKE_NPM_CLI
          ? [process.env.FORGE_SMOKE_NPM_CLI]
          : []),
        join(dirname(node), "node_modules/npm/bin/npm-cli.js"),
        join(dirname(node), "../lib/node_modules/npm/bin/npm-cli.js"),
      ].find(existsSync);
      if (!npm) throw new Error("npm CLI is required");
      const packed = JSON.parse(
        await timed("pack", () =>
          good(
            "Git pack",
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
        ),
      ) as { filename: string }[];
      writeFileSync(
        join(consumer, "package.json"),
        '{"name":"git-proof-consumer","version":"1.0.0","private":true,"type":"module"}',
      );
      await timed("install", () =>
        good(
          "Git install",
          node,
          [
            npm,
            "install",
            join(work, packed[0]!.filename),
            "--no-audit",
            "--no-fund",
            "--prefer-offline",
          ],
          consumer,
        ),
      );
    }
    const installed = join(consumer, "node_modules/forge-workflow");
    const fixture = join(root, "test/node-fixtures/l12-git/journeys.mjs");
    const nodes = [
      ...new Set(
        [node, process.env.FORGE_NODE26].filter((value): value is string =>
          Boolean(value),
        ),
      ),
    ];
    const positives = nodes.flatMap((runtime) =>
      [
        ...journeys.map((journey) => ({
          name: journey,
          file: fixture,
          mode: journey,
          expected: `PASS ${journey}:`,
        })),
        {
          name: "actual host",
          file: join(root, "test/node-fixtures/l12-git/assembly.mjs"),
          mode: "all",
          expected: "PASS Git assembly:",
        },
      ].map((positive) => {
        const cwd = mkdtempSync(join(work, "p-"));
        return {
          ...positive,
          label: `${positive.name} (${runtime})`,
          command: runtime,
          args: [positive.file, installed, cwd, positive.mode],
          cwd,
          env: process.env,
        };
      }),
    );
    const outputs = await timed("positive fixtures", () =>
      runFixtures(positives, 2, "Packed Git"),
    );
    for (const [index, output] of outputs.entries()) {
      expect(output).toContain(positives[index]!.expected);
      console.log(output.trim());
    }

    const selected = selectShard(
      counterfactuals,
      packedCoverage(process.env.STATE_NODE_LEG).shard,
    );
    // Dependency lookup reaches the shared install; neither worker changes its base package.
    const copyStarted = performance.now();
    const workers = Array.from(
      { length: Math.min(2, selected.length) },
      (_, worker) => {
        const cwd = join(work, `w-${worker}`);
        const isolated = join(cwd, "node_modules/forge-git-counterfactual");
        cpSync(installed, isolated, {
          recursive: true,
          filter: (path) => !path.endsWith(".map"),
        });
        return {
          cwd,
          isolated,
          mutations: selected
            .map((mutation, index) => ({ mutation, index }))
            .filter(({ index }) => index % 2 === worker),
        };
      },
    );
    timing("copy", copyStarted);
    await timed("mutations", () =>
      runBounded(workers, 2, async ({ cwd, isolated, mutations }) => {
        for (const { mutation, index } of mutations) {
          await timed(`mutation ${index + 1} ${mutation.journey}`, async () => {
            const target = join(isolated, "dist/src", mutation.file);
            const original = readFileSync(target, "utf8");
            expect(
              original,
              `missing mutation anchor: ${mutation.journey}`,
            ).toContain(mutation.from);
            try {
              writeFileSync(
                target,
                original.replace(mutation.from, mutation.to),
              );
              const result = await runChild(
                `Git counterfactual ${mutation.journey}`,
                node,
                [fixture, isolated, join(cwd, `m-${index}`), mutation.journey],
                {
                  cwd,
                  env: process.env,
                  inheritProcessGroup: inheritRunnerGroup(),
                  timeoutMs: 180000,
                  cleanupTimeoutMs: 5000,
                  maxOutputBytes: 1048576,
                  acceptableExitCodes: null,
                  onOutput: () => undefined,
                },
              );
              expect(
                result.status,
                `counterfactual survived: ${mutation.journey}`,
              ).not.toBe(0);
              if (mutation.kind === "assertion")
                expect(
                  result.stderr,
                  `wrong failure: ${mutation.journey}`,
                ).toContain(mutation.evidence);
            } finally {
              writeFileSync(target, original);
            }
          });
        }
      }),
    );
    console.log(
      `Packed Git: ${nodes.length} Node runtime(s), ${journeys.length} journey groups plus actual host per runtime, ${selected.length}/${counterfactuals.length} counterfactuals`,
    );
  } finally {
    const cleanupStarted = performance.now();
    try {
      // Both fixture and mutation pools drain before removing any private roots.
      rmSync(work, { recursive: true, force: true });
    } finally {
      timing("cleanup", cleanupStarted);
      timing("total", started);
    }
  }
}, 300000);
