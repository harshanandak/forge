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
import { runChild } from "../../../tools/child-runner.ts";
import { runBounded } from "../../../tools/packed-pool.ts";
import { inheritRunnerGroup } from "../../../tools/runner-policy.ts";
import { runFixtures, type Fixture } from "../../integration/fixtures/run.ts";
import {
  packedCoverage,
  selectShard,
} from "../../node-fixtures/state/counterfactuals.ts";
import { counterfactuals } from "../../node-fixtures/l12-pr/counterfactuals.ts";
const root = resolve(import.meta.dirname, "../../..");
function good(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): string {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120000,
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return result.stdout;
}
function pattern(text: string): RegExp {
  return new RegExp(
    text
      .split(/\s+/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+"),
  );
}

test("installed PR/GitHub blocks: all computed verdicts, exact head and both fenced merge barriers", async () => {
  const shared =
    process.env.PR_PACKED_CONSUMER || process.env.FORGE_PACKED_CONSUMER;
  const selected = selectShard(
    counterfactuals,
    packedCoverage(process.env.STATE_NODE_LEG).shard,
  );
  const work = mkdtempSync(join(shared ?? tmpdir(), "forge-pr-packed-"));
  try {
    const node = Bun.which("node");
    if (!node) throw new Error("Node is required");
    const consumer = shared ?? join(work, "consumer");
    if (!shared) mkdirSync(consumer);
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
      writeFileSync(
        join(consumer, "package.json"),
        JSON.stringify({
          name: "pr-packed-consumer",
          version: "1.0.0",
          private: true,
          type: "module",
        }),
      );
      good(process.execPath, ["run", "build"], root, process.env);
      const npm = [
        process.env.FORGE_SMOKE_NPM_CLI,
        join(dirname(node), "node_modules/npm/bin/npm-cli.js"),
        join(dirname(node), "../lib/node_modules/npm/bin/npm-cli.js"),
      ].find(
        (value): value is string => value !== undefined && existsSync(value),
      );
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
    } else {
      for (const phase of ["build", "pack", "install"])
        console.log(`Packed PR/GitHub ${phase}: 0 ms (shared smoke)`);
    }
    const installed = join(consumer, "node_modules/forge-workflow");
    const journey = join(root, "test/node-fixtures/l12-pr/journeys.mjs"),
      provider = join(root, "test/node-fixtures/l12-pr/provider.mjs");
    const nodes = [
      ...new Set(
        [node, process.env.FORGE_NODE26].filter((value): value is string =>
          Boolean(value),
        ),
      ),
    ];
    const positives: Fixture[] = nodes.flatMap((runtime, index) => [
      {
        label: `journey-${index}`,
        command: runtime,
        args: [
          journey,
          installed,
          join(work, `journey-${index}`),
          "all",
          provider,
        ],
        cwd: consumer,
        env,
      },
      {
        label: `actual-host-${index}`,
        command: runtime,
        args: [
          join(root, "test/node-fixtures/l12-pr/assembly.mjs"),
          installed,
          join(work, `assembly-${index}`),
        ],
        cwd: consumer,
        env,
      },
      {
        label: `head-checks-${index}`,
        command: runtime,
        args: [
          journey,
          installed,
          join(work, `head-checks-${index}`),
          "head-checks",
          provider,
        ],
        cwd: consumer,
        env,
      },
    ]);
    const outputs = await runFixtures(positives, 2, "Packed PR/GitHub");
    for (const [index, fixture] of positives.entries())
      expect(outputs[index]).toContain(
        fixture.label.startsWith("actual-host")
          ? "state.sqlite before=false, after=false"
          : `PR journey ${fixture.label.startsWith("head-checks") ? "head-checks" : "all"}: passed`,
      );
    const workers = Array.from(
      { length: Math.min(2, selected.length) },
      (_, index) => {
        const cwd = join(work, `worker-${index}`),
          isolated = join(cwd, "node_modules/forge-pr-counterfactual");
        cpSync(installed, isolated, {
          recursive: true,
          filter: (path) => !path.endsWith(".map") && !path.endsWith(".ts"),
        });
        return {
          cwd,
          isolated,
          mutations: selected.filter((_, item) => item % 2 === index),
        };
      },
    );
    // Both the pool and runChild wait for close/tree cleanup before this workspace is removed.
    await runBounded(workers, 2, async ({ cwd, isolated, mutations }) => {
      for (const [index, mutation] of mutations.entries()) {
        const target = join(isolated, "dist/src", mutation.file),
          original = readFileSync(target, "utf8"),
          find = pattern(mutation.from);
        expect(original, `counterfactual anchor ${mutation.journey}`).toMatch(
          find,
        );
        try {
          const changed = original.replace(find, mutation.to);
          expect(changed).not.toBe(original);
          writeFileSync(target, changed);
          const result = await runChild(
            `PR counterfactual ${mutation.journey}`,
            node,
            [
              journey,
              isolated,
              join(cwd, `mutation-${index}`),
              mutation.journey,
              provider,
            ],
            {
              cwd,
              env,
              inheritProcessGroup: inheritRunnerGroup(),
              timeoutMs: 120000,
              cleanupTimeoutMs: 5000,
              maxOutputBytes: 1048576,
              acceptableExitCodes: null,
              onOutput: () => {},
            },
          );
          expect(
            result.status,
            `counterfactual survived: ${mutation.journey}\n${result.stdout}\n${result.stderr}`,
          ).not.toBe(0);
          expect(result.stderr).toContain(mutation.evidence);
        } finally {
          writeFileSync(target, original);
        }
      }
    });
    console.log(
      `Packed PR/GitHub: ${nodes.length} Node runtimes; ${positives.length} independent positive fixtures; ${selected.length}/${counterfactuals.length} remove-the-fix journeys`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 180000);
