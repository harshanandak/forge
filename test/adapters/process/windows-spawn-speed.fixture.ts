// Times the process adapter against a bare child_process spawn of the same program, run by run.
// The same file prints a report when Node runs it directly.
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createProcessPort } from "../../../src/adapters/process/index.ts";

export const fixturePath = fileURLToPath(import.meta.url);

const RUNS = 20;
const WARMUP = 3;
/** The adapter may cost this much more than a bare spawn, measured on the median. */
export const MARGIN_MS = 25;

export interface SpeedReport {
  readonly runtime: string;
  readonly bare: readonly number[];
  readonly adapter: readonly number[];
  readonly bareMedian: number;
  readonly adapterMedian: number;
  readonly bareP90: number;
  readonly adapterP90: number;
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.floor(fraction * sorted.length),
  );
  return sorted[index] as number;
}

const KEPT_ENVIRONMENT = new Set([
  "path",
  "pathext",
  "systemroot",
  "windir",
  "home",
  "tmp",
  "temp",
]);

function environment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && KEPT_ENVIRONMENT.has(entry[0].toLowerCase()),
    ),
  );
}

export async function measureSpawnSpeed(): Promise<SpeedReport> {
  const env = environment();
  const cwd = tmpdir();
  const port = createProcessPort({
    supervision: {
      cleanupTimeoutMs: 5000,
      pollIntervalMs: 25,
      drainTimeoutMs: 250,
      maxConcurrent: 1,
    },
  });
  const git = port.resolve("git", env);
  if (git.kind !== "resolved") throw new Error("git is not installed");

  const bareRun = (): Promise<number> => {
    const started = performance.now();
    return new Promise((done, fail) => {
      const child = spawn(git.path, ["--version"], {
        cwd,
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.resume();
      child.stderr.resume();
      child.once("error", fail);
      child.once("close", (code) =>
        code === 0
          ? done(performance.now() - started)
          : fail(new Error(`git --version exited ${code}`)),
      );
    });
  };
  const adapterRun = async (): Promise<number> => {
    const started = performance.now();
    const result = await port.run(git, ["--version"], {
      cwd,
      env,
      timeoutMs: 30_000,
      maxOutputBytes: 4096,
    });
    if (result.exitCode !== 0)
      throw new Error(`adapter git --version exited ${result.exitCode}`);
    return performance.now() - started;
  };

  for (let index = 0; index < WARMUP; index += 1) {
    await bareRun();
    await adapterRun();
  }
  const bare: number[] = [];
  const adapter: number[] = [];
  // Alternate which side goes first so a drifting runner favours neither.
  for (let index = 0; index < RUNS; index += 1) {
    if (index % 2 === 0) {
      bare.push(await bareRun());
      adapter.push(await adapterRun());
    } else {
      adapter.push(await adapterRun());
      bare.push(await bareRun());
    }
  }
  return {
    runtime:
      process.versions.bun === undefined
        ? `node ${process.version}`
        : `bun ${process.versions.bun}`,
    bare,
    adapter,
    bareMedian: percentile(bare, 0.5),
    adapterMedian: percentile(adapter, 0.5),
    bareP90: percentile(bare, 0.9),
    adapterP90: percentile(adapter, 0.9),
  };
}

const isEntry =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]).toLowerCase() === fixturePath.toLowerCase();

if (isEntry) process.stdout.write(JSON.stringify(await measureSpawnSpeed()));
