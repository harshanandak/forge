import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";
import type {
  ProcessResult,
  SpawnOptions,
  ProcessSupervisionReport,
} from "../../ports/process.ts";
import { ProcessSpawnError } from "./errors.ts";
import { planSpawn } from "./plan.ts";
import type { Platform } from "./platform.ts";
import {
  openContainment,
  validateHostOptions,
  type ContainmentOptions,
} from "./containment.ts";
import { StreamCapture } from "./capture.ts";
import { runProcessTree } from "./process-tree.ts";

const MAX_TIMER_MS = 2147483647;
import { MAX_SUPERVISORS, validateSupervision } from "./supervision.ts";
let activeSupervisors = 0;

/** IPC errno values are untrusted; reconstruct only a host-known system error code. */
export function supervisedSpawnFailure(code: unknown): ProcessSpawnError {
  const cause =
    typeof code === "string" && Object.hasOwn(constants.errno, code)
      ? Object.assign(new Error(`Command spawn failed (${code})`), { code })
      : undefined;
  return new ProcessSpawnError(
    "SPAWN_FAILED",
    "Could not start supervised command",
    cause,
  );
}

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
    // goes through the helper and its Job Object; strict refuses on POSIX before spawning.
    if (options.containment !== "strict" && platform !== "win32")
      return await runProcessTree(
        planSpawn(executable, args, options.env, platform),
        options,
        supervisionConfig,
        started,
      );
    // Capability setup is complete before even the waiting supervisor is spawned.
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
    const plan = planSpawn(executable, args, options.env, platform);
    const container = scope;
    return await new Promise<ProcessResult>((resolveRun, rejectRun) => {
      const helper = fileURLToPath(
        new URL(
          import.meta.url.endsWith(".ts")
            ? "./supervisor-child.ts"
            : "./supervisor-child.js",
          import.meta.url,
        ),
      );
      const helperArgs =
        process.versions.bun !== undefined
          ? [helper]
          : import.meta.url.endsWith(".ts")
            ? ["--v8-pool-size=1", helper]
            : ["--jitless", "--v8-pool-size=1", helper];
      helperArgs.push(
        String(
          Math.min(
            MAX_TIMER_MS,
            Math.max(
              1,
              Math.ceil(options.timeoutMs - (performance.now() - started)),
            ),
          ),
        ),
      );
      const child = spawn(process.execPath, helperArgs, {
        cwd: options.cwd,
        env:
          platform === "win32"
            ? { SystemRoot: process.env.SystemRoot ?? "C:/Windows" }
            : {},
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        windowsHide: true,
        shell: false,
      });
      const stdout = new StreamCapture(options.maxOutputBytes, options.capture),
        stderr = new StreamCapture(options.maxOutputBytes, options.capture);
      const capture = (stream: StreamCapture, chunk: Buffer): void => {
        try {
          stream.push(chunk);
        } catch (error) {
          void finish(
            error instanceof Error ? error : new Error("Output capture failed"),
          );
        }
      };
      child.stdout?.on("data", (chunk: Buffer) => capture(stdout, chunk));
      child.stderr?.on("data", (chunk: Buffer) => capture(stderr, chunk));
      let timedOut = false,
        interrupted = false,
        attached = false,
        closing = false;
      let exited = false,
        pipesClosed = false;
      let commandPid: number | undefined;
      let residentBytes = 0;
      let exitCode: number | null = null;
      let exitSignal: string | null = null;
      let finishExit!: () => void;
      const exitPromise = new Promise<void>((resolve) => {
        finishExit = resolve;
      });
      let finishPipes!: () => void;
      const pipesPromise = new Promise<void>((resolve) => {
        finishPipes = resolve;
      });
      child.once("exit", () => {
        exited = true;
        finishExit();
        if (!closing)
          void finish(
            new ProcessSpawnError(
              "SPAWN_FAILED",
              "Process supervisor exited before completion",
            ),
          );
      });
      child.once("close", () => {
        pipesClosed = true;
        finishPipes();
      });
      const pause = async (
        pending: Promise<void>,
        ms: number,
      ): Promise<void> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            pending,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, ms);
            }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      };
      const finish = async (failure?: Error): Promise<void> => {
        if (closing) return;
        closing = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", cancel);
        let stoppedPids: readonly number[] = [];
        let cleanupFailure: unknown;
        try {
          if (attached) stoppedPids = await container.stop();
          // Before attachment the helper has not received any command and has no descendants.
          else if (child.pid !== undefined) child.kill("SIGKILL");
          if (!exited)
            await pause(exitPromise, supervisionConfig.cleanupTimeoutMs);
          if (!exited)
            throw new ProcessSpawnError(
              "TREE_KILL_FAILED",
              "Supervisor did not exit after termination",
            );
          if (!pipesClosed)
            await pause(pipesPromise, supervisionConfig.drainTimeoutMs);
        } catch (error) {
          cleanupFailure = error;
        } finally {
          child.stdout?.destroy();
          child.stderr?.destroy();
          if (child.connected) child.disconnect();
        }
        if (cleanupFailure !== undefined) {
          rejectRun(
            cleanupFailure instanceof Error
              ? cleanupFailure
              : new ProcessSpawnError(
                  "TREE_KILL_FAILED",
                  "Process cleanup failed",
                  cleanupFailure,
                ),
          );
          return;
        }
        if (failure) {
          rejectRun(failure);
          return;
        }
        const supervision: ProcessSupervisionReport = {
          mode: options.containment ?? "supervised",
          backend: container.backend,
          supervisorPid: child.pid!,
          ...(commandPid === undefined ? {} : { commandPid }),
          stoppedPids,
          confirmed: true,
          pidSnapshotComplete: true,
          supervisorResidentBytes: residentBytes,
        };
        resolveRun({
          exitCode: interrupted ? null : exitCode,
          signal: interrupted ? "SIGKILL" : exitSignal,
          stdout: stdout.text(),
          stderr: stderr.text(),
          timedOut,
          truncated: stdout.truncated || stderr.truncated,
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
        });
      };
      const cancel = (): void => {
        interrupted = true;
        void finish();
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
      child.once("error", (cause) => {
        if (child.pid === undefined) {
          exited = true;
          finishExit();
        }
        void finish(
          new ProcessSpawnError(
            "SPAWN_FAILED",
            "Could not start process supervisor",
            cause,
          ),
        );
      });
      child.on("message", (value: unknown) => {
        if (closing || value === null || typeof value !== "object") return;
        const message = value as Record<string, unknown>;
        if (message.kind === "ready") {
          try {
            if (child.pid === undefined)
              throw new Error("Supervisor has no PID");
            container.attach(child.pid);
            attached = true;
            residentBytes =
              typeof message.residentBytes === "number"
                ? message.residentBytes
                : 0;
            child.send(
              {
                kind: "start",
                file: plan.file,
                args: plan.args,
                cwd: options.cwd,
                env: { ...options.env },
                verbatim: plan.windowsVerbatimArguments,
                ...(options.stdin === undefined
                  ? {}
                  : { stdin: options.stdin }),
              },
              (error) => {
                if (error)
                  void finish(
                    new ProcessSpawnError(
                      "SPAWN_FAILED",
                      "Could not start supervised command",
                      error,
                    ),
                  );
              },
            );
          } catch (error) {
            void finish(
              error instanceof Error
                ? error
                : new ProcessSpawnError(
                    "CONTAINMENT_UNAVAILABLE",
                    "Could not attach supervisor",
                    error,
                  ),
            );
          }
        } else if (
          message.kind === "started" &&
          typeof message.pid === "number"
        )
          commandPid = message.pid;
        else if (message.kind === "exited") {
          exitCode = typeof message.code === "number" ? message.code : null;
          exitSignal =
            typeof message.signal === "string" ? message.signal : null;
          void finish();
        } else if (message.kind === "failed")
          void finish(supervisedSpawnFailure(message.errno));
      });
    });
  } finally {
    try {
      scope?.close();
    } finally {
      activeSupervisors--;
    }
  }
}
