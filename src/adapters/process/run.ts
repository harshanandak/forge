import { existsSync } from "node:fs";
import type {
  ProcessResult,
  SpawnOptions,
  ProcessSupervisionReport,
} from "../../ports/process.ts";
import { ProcessSpawnError } from "./errors.ts";
import { planSpawn, type SpawnPlan } from "./plan.ts";
import type { Platform } from "./platform.ts";
import {
  openContainment,
  validateHostOptions,
  type ContainmentOptions,
  type ContainmentScope,
} from "./containment.ts";
import { captureStreams } from "./capture.ts";
import { runProcessTree } from "./process-tree.ts";
import {
  MAX_SUPERVISORS,
  validateSupervision,
  type SupervisionOptions,
} from "./supervision.ts";

const MAX_TIMER_MS = 2147483647;
let activeSupervisors = 0;

function validate(options: SpawnOptions): void {
  const bad = (what: string): never => {
    throw new ProcessSpawnError("INVALID_OPTIONS", what);
  };
  if (
    options.containment !== undefined &&
    options.containment !== "strict" &&
    options.containment !== "supervised"
  )
    bad("Unknown process containment mode.");
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > MAX_TIMER_MS
  )
    bad("timeoutMs must be an integer from 1 to 2147483647.");
  if (!Number.isInteger(options.maxOutputBytes) || options.maxOutputBytes < 0)
    bad("maxOutputBytes must be a non-negative integer.");
  if (
    options.capture &&
    (!Number.isSafeInteger(options.capture.headBytes) ||
      options.capture.headBytes < 0 ||
      !Number.isSafeInteger(options.capture.tailBytes) ||
      options.capture.tailBytes < 0 ||
      options.capture.headBytes + options.capture.tailBytes >
        options.maxOutputBytes)
  )
    bad("capture headBytes + tailBytes must fit maxOutputBytes.");
  if (!existsSync(options.cwd))
    bad(`the working directory "${options.cwd}" does not exist.`);
  for (const [name, value] of Object.entries(options.env)) {
    if (typeof value !== "string" || name === "" || name.includes("="))
      bad(`environment entry "${name}" is not a plain name=string pair.`);
  }
}

export async function runProcess(
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
  platform: Platform,
  containmentOptions: ContainmentOptions = {},
): Promise<ProcessResult> {
  validate(options);
  const supervisionConfig = validateSupervision(containmentOptions.supervision);
  validateHostOptions(containmentOptions);
  if (options.signal?.aborted)
    throw new ProcessSpawnError(
      "INVALID_OPTIONS",
      "Process invocation is cancelled",
    );
  if (
    activeSupervisors >=
    Math.min(MAX_SUPERVISORS, supervisionConfig.maxConcurrent)
  )
    throw new ProcessSpawnError(
      "PROCESS_LIMIT_EXCEEDED",
      "The configured process supervisor limit is reached",
    );
  activeSupervisors++;
  const started = performance.now();
  let scope: Awaited<ReturnType<typeof openContainment>> | undefined;
  try {
    // On POSIX the default mode lets the OS own the tree as a process group. Every Windows run
    // starts the command inside its own Job Object; strict refuses on POSIX before spawning.
    if (options.containment !== "strict" && platform !== "win32")
      return await runProcessTree(
        planSpawn(executable, args, options.env, platform),
        options,
        supervisionConfig,
        started,
      );
    // Capability setup is complete before the command is started.
    scope = await openContainment(
      platform,
      options.containment === "strict",
      containmentOptions,
    );
    if (options.signal?.aborted)
      throw new ProcessSpawnError(
        "INVALID_OPTIONS",
        "Process invocation is cancelled",
      );
    return await runInJob(
      planSpawn(executable, args, options.env, platform),
      scope,
      options,
      supervisionConfig,
      started,
    );
  } finally {
    try {
      scope?.close();
    } finally {
      activeSupervisors--;
    }
  }
}

/**
 * Starts the command inside the scope's per-command job and waits for it. The job ends every
 * descendant when the command exits, times out or is cancelled; nothing outlives the call.
 *
 * Accepted limit: the deadline is a host timer. If the host event loop is blocked, the command keeps
 * running until the loop recovers; if the host dies, closing the job handle ends it (kill-on-close).
 * A job object has no wall-clock limit (its time limits count CPU time, not elapsed time), so a
 * native deadline would need a helper thread or process, which this launcher exists to avoid. See
 * docs/reference/windows-process-supervision.md.
 */
async function runInJob(
  plan: SpawnPlan,
  scope: ContainmentScope,
  options: SpawnOptions,
  config: SupervisionOptions,
  started: number,
): Promise<ProcessResult> {
  // Loaded here so POSIX never loads the Windows launcher or koffi.
  const { launchCaptured, stopCaptured } =
    await import("./windows-launch-stdio.ts");
  const { stdout, stderr } = captureStreams(options);
  let timedOut = false;
  let interrupted = false;
  let wake!: () => void;
  const stopRequested = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const cancel = (): void => {
    interrupted = true;
    wake();
  };
  const timeout = setTimeout(
    () => {
      timedOut = true;
      cancel();
    },
    Math.min(
      Math.max(1, options.timeoutMs - (performance.now() - started)),
      MAX_TIMER_MS,
    ),
  );
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  try {
    // A command that cannot start rejects here with SPAWN_FAILED and its errno; nothing is left.
    const launch = await launchCaptured(plan, scope.job, {
      cwd: options.cwd,
      env: options.env,
      pollIntervalMs: config.pollIntervalMs,
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      onStdout: (chunk) => stdout.push(chunk),
      onStderr: (chunk) => stderr.push(chunk),
    });
    let exitCode: number | null = null;
    let commandExited = false;
    let failure: Error | undefined;
    try {
      const never = new Promise<never>(() => undefined);
      // A capture failure rejects `drained` long before the command exits.
      const capturing = launch.drained.then(() => never);
      const code = await Promise.race([
        launch.exited,
        stopRequested.then(() => undefined),
        capturing,
      ]);
      if (code !== undefined) {
        commandExited = true;
        exitCode = code;
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", cancel);
    let stop: Awaited<ReturnType<typeof stopCaptured>> | undefined;
    let cleanupFailure: unknown;
    try {
      stop = await stopCaptured(launch, scope.job, {
        drainTimeoutMs: config.drainTimeoutMs,
        commandExited,
      });
    } catch (error) {
      cleanupFailure = error;
    }
    try {
      launch.dispose();
    } catch (error) {
      cleanupFailure ??= error;
    }
    if (cleanupFailure !== undefined || stop === undefined)
      throw cleanupFailure instanceof Error
        ? cleanupFailure
        : new ProcessSpawnError(
            "TREE_KILL_FAILED",
            "Process cleanup failed",
            cleanupFailure,
          );
    if (failure) throw failure;
    const pipesClosed = stop.pipesClosed;
    const supervision: ProcessSupervisionReport = {
      mode: options.containment ?? "supervised",
      backend: scope.backend,
      // The launcher starts the command itself, so the command is its own supervisor.
      supervisorPid: launch.pid,
      commandPid: launch.pid,
      // The command itself is always part of what ended; the job snapshot adds anything it left behind.
      stoppedPids: [...new Set([launch.pid, ...stop.stopped])],
      confirmed: true,
      pidSnapshotComplete: true,
      supervisorResidentBytes: 0,
    };
    return {
      exitCode: interrupted ? null : exitCode,
      signal: interrupted ? "SIGKILL" : null,
      stdout: stdout.text(),
      stderr: stderr.text(),
      timedOut,
      truncated: !pipesClosed || stdout.truncated || stderr.truncated,
      durationMs: Math.round(performance.now() - started),
      supervision,
      ...(options.capture
        ? {
            outputEvidence: {
              stdout: stdout.evidence(pipesClosed),
              stderr: stderr.evidence(pipesClosed),
            },
          }
        : {}),
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", cancel);
  }
}
