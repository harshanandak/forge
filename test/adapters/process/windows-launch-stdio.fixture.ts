// Runs the Windows launcher's captured path and the current supervised path on the same child.
// The same file is the child program, and prints a full report when Node runs it directly.
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureStreams } from "../../../src/adapters/process/capture.ts";
import { planSpawn } from "../../../src/adapters/process/plan.ts";
import { runProcess } from "../../../src/adapters/process/run.ts";
import { openWindowsJob } from "../../../src/adapters/process/windows-job.ts";
import {
  launchCaptured,
  type CapturedLaunch,
} from "../../../src/adapters/process/windows-launch-stdio.ts";
import type {
  ProcessOutputEvidence,
  SpawnOptions,
} from "../../../src/ports/process.ts";

export const fixturePath = fileURLToPath(import.meta.url);

const neutralCwd = tmpdir();
const root = process.env.SystemRoot ?? "C:\\Windows";
const supervision = {
  cleanupTimeoutMs: 5000,
  pollIntervalMs: 25,
  drainTimeoutMs: 250,
  maxConcurrent: 1,
};
const STDOUT_BYTES = 1024 * 1024;
const STDERR_BYTES = 64 * 1024;
const input = `${"stdin-payload ".repeat(300)}é日本😀`;

export interface Report {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly evidence?: {
    readonly stdout: ProcessOutputEvidence;
    readonly stderr: ProcessOutputEvidence;
  };
}
export interface Failure {
  readonly code: unknown;
  readonly causeCode: unknown;
}
export interface Scenarios {
  readonly evidence: { readonly launched: Report; readonly current: Report };
  readonly capped: { readonly launched: Report; readonly current: Report };
  readonly missing: readonly {
    readonly launched: Failure;
    readonly current: Failure;
  }[];
  readonly quiet: {
    readonly active: number;
    readonly terminations: number;
  };
}

function options(variant: "evidence" | "capped"): SpawnOptions {
  return {
    cwd: neutralCwd,
    env: { SystemRoot: root },
    timeoutMs: 60_000,
    maxOutputBytes: variant === "capped" ? 1000 : 2 * 1024 * 1024,
    ...(variant === "capped"
      ? {}
      : { capture: { headBytes: 64 * 1024, tailBytes: 64 * 1024 } }),
    stdin: input,
  };
}

function job(): ReturnType<typeof openWindowsJob> {
  return openWindowsJob({ cleanupTimeoutMs: 5000, pollIntervalMs: 25 });
}

async function launchedRun(
  nodePath: string,
  args: readonly string[],
  spawnOptions: SpawnOptions,
): Promise<Report> {
  const owner = job();
  const { stdout, stderr } = captureStreams(spawnOptions);
  let launch: CapturedLaunch | undefined;
  try {
    launch = await launchCaptured(
      planSpawn(nodePath, args, spawnOptions.env, "win32"),
      owner,
      {
        cwd: spawnOptions.cwd,
        env: spawnOptions.env,
        pollIntervalMs: 25,
        ...(spawnOptions.stdin === undefined
          ? {}
          : { stdin: spawnOptions.stdin }),
        onStdout: (chunk) => stdout.push(chunk),
        onStderr: (chunk) => stderr.push(chunk),
      },
    );
    const exitCode = await launch.exited;
    await launch.drained;
    return {
      exitCode,
      stdout: stdout.text(),
      stderr: stderr.text(),
      truncated: stdout.truncated || stderr.truncated,
      ...(spawnOptions.capture
        ? {
            evidence: {
              stdout: stdout.evidence(true),
              stderr: stderr.evidence(true),
            },
          }
        : {}),
    };
  } finally {
    try {
      await owner.stop();
    } finally {
      try {
        launch?.dispose();
      } finally {
        owner.close();
      }
    }
  }
}

async function currentRun(
  nodePath: string,
  args: readonly string[],
  spawnOptions: SpawnOptions,
): Promise<Report> {
  const result = await runProcess(nodePath, args, spawnOptions, "win32", {
    supervision,
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    truncated: result.truncated,
    ...(result.outputEvidence ? { evidence: result.outputEvidence } : {}),
  };
}

async function failureOf(action: () => Promise<unknown>): Promise<Failure> {
  try {
    await action();
  } catch (error) {
    const cause = (error as { cause?: { code?: unknown } }).cause;
    return {
      code: (error as { code?: unknown }).code,
      causeCode: cause?.code,
    };
  }
  return { code: "launched", causeCode: undefined };
}

async function missingScenario(): Promise<Scenarios["missing"]> {
  // One folder that does not exist (path not found) and one file missing from a real folder.
  const files = [
    join(neutralCwd, "forge-missing-launcher", "nope.exe"),
    join(root, "forge-missing-launcher.exe"),
  ];
  const results = [];
  for (const file of files) {
    const spawnOptions = options("capped");
    const owner = job();
    try {
      const launched = await failureOf(() =>
        launchCaptured(planSpawn(file, [], spawnOptions.env, "win32"), owner, {
          cwd: spawnOptions.cwd,
          env: spawnOptions.env,
          pollIntervalMs: 25,
          onStdout: () => undefined,
          onStderr: () => undefined,
        }),
      );
      const current = await failureOf(() =>
        runProcess(file, [], spawnOptions, "win32", { supervision }),
      );
      results.push({ launched, current });
    } finally {
      owner.close();
    }
  }
  return results;
}

/** A command with no descendants exits; the job is already empty, so stop must not terminate. */
async function quietScenario(nodePath: string): Promise<Scenarios["quiet"]> {
  const owner = job();
  let launch: CapturedLaunch | undefined;
  try {
    launch = await launchCaptured(
      planSpawn(
        nodePath,
        [fixturePath, "quiet"],
        { SystemRoot: root },
        "win32",
      ),
      owner,
      {
        cwd: neutralCwd,
        env: { SystemRoot: root },
        pollIntervalMs: 25,
        onStdout: () => undefined,
        onStderr: () => undefined,
      },
    );
    await launch.exited;
    await launch.drained;
    const active = owner.activeCount();
    await owner.stop();
    return { active, terminations: owner.terminations() };
  } finally {
    try {
      launch?.dispose();
    } finally {
      owner.close();
    }
  }
}

export async function scenarios(nodePath: string): Promise<Scenarios> {
  const args = [fixturePath, "child"];
  const both = async (
    variant: "evidence" | "capped",
  ): Promise<{ launched: Report; current: Report }> => ({
    launched: await launchedRun(nodePath, args, options(variant)),
    current: await currentRun(nodePath, args, options(variant)),
  });
  return {
    evidence: await both("evidence"),
    capped: await both("capped"),
    missing: await missingScenario(),
    quiet: await quietScenario(nodePath),
  };
}

export const expectedBytes = { stdout: STDOUT_BYTES, stderr: STDERR_BYTES };
export const expectedInput = input;

const isEntry =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]).toLowerCase() === fixturePath.toLowerCase();

if (isEntry) {
  const [mode] = process.argv.slice(2);
  if (mode === "child") {
    // Writes 1 MiB to stdout and 64 KiB to stderr, echoes stdin, and exits 7.
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => {
      const pattern = Buffer.alloc(STDOUT_BYTES);
      for (let index = 0; index < pattern.length; index += 1)
        pattern[index] = 33 + (index % 90);
      process.stdout.write(
        Buffer.concat([pattern, Buffer.from("echo:"), ...chunks]),
      );
      process.stderr.write(Buffer.alloc(STDERR_BYTES, "e"));
      process.exitCode = 7;
    });
  } else if (mode === "run") {
    process.stdout.write(JSON.stringify(await scenarios(process.execPath)));
  }
}
