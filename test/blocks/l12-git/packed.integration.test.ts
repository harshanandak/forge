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
import { dirname, join, resolve } from "node:path";
import { counterfactuals } from "../../node-fixtures/l12-git/counterfactuals.ts";
import {
  packedCoverage,
  selectShard,
} from "../../node-fixtures/state/counterfactuals.ts";

const root = resolve(import.meta.dirname, "../../..");
function run(command: string, args: readonly string[], cwd: string) {
  return spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 180000,
    maxBuffer: 1048576,
  });
}
function good(command: string, args: readonly string[], cwd: string): string {
  const result = run(command, args, cwd);
  expect(
    result.status,
    [result.error?.message, result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n"),
  ).toBe(0);
  return result.stdout;
}

test("installed git block: real clone journeys and remove-the-fix checks", () => {
  const sharedConsumer = process.env.FORGE_PACKED_CONSUMER;
  const work = mkdtempSync(
    join(sharedConsumer ?? tmpdir(), sharedConsumer ? "git-" : "forge-git-"),
  );
  try {
    const node = Bun.which("node");
    if (!node) throw new Error("Node is required");
    const consumer = sharedConsumer ?? join(work, "consumer");
    if (!sharedConsumer) {
      good(process.execPath, ["run", "build"], root);
      const npm = [
        ...(process.env.FORGE_SMOKE_NPM_CLI
          ? [process.env.FORGE_SMOKE_NPM_CLI]
          : []),
        join(dirname(node), "node_modules/npm/bin/npm-cli.js"),
        join(dirname(node), "../lib/node_modules/npm/bin/npm-cli.js"),
      ].find(existsSync);
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
        ),
      ) as { filename: string }[];
      mkdirSync(consumer);
      writeFileSync(
        join(consumer, "package.json"),
        '{"name":"git-proof-consumer","version":"1.0.0","private":true,"type":"module"}',
      );
      good(
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
    for (const [index, runtime] of nodes.entries()) {
      const output = good(
        runtime,
        [fixture, installed, join(work, `journey-${index}`), "all"],
        consumer,
      );
      for (const journey of [
        "base",
        "unstarted",
        "merge",
        "squash",
        "push",
        "removal-race",
        "hook-recovery",
        "hooks",
      ])
        expect(output).toContain(`PASS ${journey}:`);
      console.log(output.trim());
      const host = good(
        runtime,
        [
          join(root, "test/node-fixtures/l12-git/assembly.mjs"),
          installed,
          join(work, `host-${index}`),
        ],
        consumer,
      );
      expect(host).toContain("PASS Git assembly:");
      console.log(host.trim());
    }
    const isolated = join(
      sharedConsumer ? work : consumer,
      "node_modules/forge-git-counterfactual",
    );
    cpSync(installed, isolated, {
      recursive: true,
      filter: (path) => !path.endsWith(".map"),
    });
    // Preserve dependency lookup when the shared smoke consumer lives elsewhere.
    const packagePath = join(isolated, "package.json");
    expect(existsSync(packagePath)).toBe(true);
    const selected = selectShard(
      counterfactuals,
      packedCoverage(process.env.STATE_NODE_LEG).shard,
    );
    for (const [index, mutation] of selected.entries()) {
      const target = join(isolated, "dist/src", mutation.file);
      const original = readFileSync(target, "utf8");
      expect(
        original,
        `missing mutation anchor: ${mutation.journey}`,
      ).toContain(mutation.from);
      try {
        writeFileSync(target, original.replace(mutation.from, mutation.to));
        const result = run(
          node,
          [
            fixture,
            isolated,
            join(work, `mutation-${index}`),
            mutation.journey,
          ],
          consumer,
        );
        expect(
          result.status,
          `counterfactual survived: ${mutation.journey}`,
        ).not.toBe(0);
        if (mutation.kind === "assertion")
          expect(result.stderr, `wrong failure: ${mutation.journey}`).toContain(
            mutation.evidence,
          );
      } finally {
        writeFileSync(target, original);
      }
    }
    console.log(
      `Packed Git: ${nodes.length} Node runtime(s), ${selected.length} counterfactuals`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 300000);
