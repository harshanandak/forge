// [integration] Throwaway diagnostics: built Node CLI processes with isolated fixture stores.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { createAssembly as AssemblyFactory } from "../../src/assembly/index.ts";

interface Timing {
  totalMs: number;
  accountedMs: number;
  entryMs: number;
  phases: Record<string, { ms: number; selfMs: number; count: number }>;
  counts: Record<string, number>;
}

test("integration: print five built CLI startup samples per command", async () => {
  const node = Bun.which("node");
  if (!node) throw new Error("Node runtime required");
  const root = mkdtempSync(join(tmpdir(), "forge-cli-startup-"));
  const project = join(root, "project");
  const device = join(root, "device");
  const cli = resolve(import.meta.dirname, "../../dist/bin/forge.js");
  const timingFile = join(root, "timings.jsonl");
  const env = {
    ...process.env,
    FORGE_DEVICE_ROOT: device,
    FORGE_SESSION: "cli-startup-measurement",
    FORGE_DEVICE_ID: "cli-startup-measurement",
    FORGE_CLI_TIMING_FILE: timingFile,
  };
  try {
    mkdirSync(join(project, ".forge"), { recursive: true });
    writeFileSync(
      join(project, "package.json"),
      '{"name":"cli-startup-fixture","private":true}',
    );
    writeFileSync(
      join(project, ".forge/config.yaml"),
      "schemaVersion: forge.config/1\nblocks:\n  memory:\n    source:\n      builtin: forge/memory\n",
    );
    const git = spawnSync("git", ["init", "--quiet"], {
      cwd: project,
      env,
      windowsHide: true,
      timeout: 20_000,
    });
    expect(git.error).toBeUndefined();
    expect(git.status, git.stderr?.toString()).toBe(0);
    // Seed through the built API so all five reads open an existing real store.
    const { createAssembly } = (await import(
      pathToFileURL(
        resolve(import.meta.dirname, "../../dist/src/assembly/index.js"),
      ).href
    )) as { createAssembly: typeof AssemblyFactory };
    const assembly = await createAssembly({
      root: project,
      deviceRoot: device,
    });
    try {
      const seeded = await assembly.catalog.invoke({
        schemaVersion: "forge.invocation/1",
        requestId: "cli-startup-seed",
        op: "memory.add",
        input: {
          text: "startup measurement fixture",
          level: "device",
          scope: "startup",
        },
        caller: "human",
        context: {
          actor: { kind: "human", id: "fixture" },
          project: { id: project, root: project },
          device: { id: device },
        },
      });
      expect(seeded.ok, JSON.stringify(seeded)).toBe(true);
    } finally {
      await assembly.close();
    }
    let calls = 0;
    // memory.search is the store-backed list equivalent in this catalog.
    for (const args of [
      ["--version"],
      ["catalog", "list"],
      ["memory", "search", "--input", '{"query":"startup","level":"device"}'],
    ]) {
      for (let sample = 1; sample <= 5; sample++) {
        const started = performance.now();
        const run = spawnSync(node, [cli, ...args], {
          cwd: project,
          env,
          encoding: "utf8",
          windowsHide: true,
          timeout: 20_000,
        });
        const wallMs = performance.now() - started;
        const lines = readFileSync(timingFile, "utf8").trim().split("\n");
        calls++;
        expect(lines).toHaveLength(calls);
        const timing = JSON.parse(lines.at(-1)!) as Timing;
        // The child's time origin follows OS process creation. The parent captures the rest.
        const launchExitMs = wallMs - timing.totalMs;
        const report = {
          ...timing,
          command: args.slice(0, 2).join(" "),
          sample,
          wallMs,
          phases: {
            ...timing.phases,
            "process.launch_and_exit": {
              ms: launchExitMs,
              selfMs: launchExitMs,
              count: 1,
            },
          },
          accountedMs: timing.accountedMs + launchExitMs,
        };
        console.log(JSON.stringify(report));
        expect(run.error, run.stderr).toBeUndefined();
        expect(run.status, run.stderr + run.stdout).toBe(0);
        expect(Math.abs(wallMs - report.accountedMs)).toBeLessThan(
          wallMs * 0.1,
        );
        expect(launchExitMs).toBeGreaterThanOrEqual(0);
        expect(timing.phases["modules.graph"]?.count).toBe(1);
        expect(timing.counts["modules.loaded"]).toBeGreaterThan(0);
        if (args[0] === "memory") {
          expect(JSON.parse(run.stdout)).toMatchObject({ ok: true });
          expect(run.stdout).toContain("startup measurement fixture");
          expect(timing.counts["stores.opened"]).toBeGreaterThan(0);
          expect(timing.phases["handler.execute"]?.count).toBe(1);
        }
      }
    }
    expect(calls).toBe(15);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
