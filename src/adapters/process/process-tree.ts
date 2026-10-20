import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import type { ProcessResult, SpawnOptions } from "../../ports/process.ts";
import { StreamCapture } from "./capture.ts";
import { ProcessSpawnError } from "./errors.ts";
import type { SpawnPlan } from "./plan.ts";
import { pathFor, type Platform } from "./platform.ts";
import type { SupervisionOptions } from "./supervision.ts";

/**
 * Ends the tree rooted at `pid` the way the OS already models it. On POSIX the command leads its
 * own process group: SIGTERM the group, then SIGKILL whatever is left after half the cleanup
 * budget. On Windows `taskkill /T /F` walks the parent links. Resolves to whether the end was
 * confirmed (the group is gone, or taskkill succeeded) within `cleanupTimeoutMs`.
 */
export async function endProcessTree(
  pid: number,
  platform: Platform,
  timing: Pick<SupervisionOptions, "cleanupTimeoutMs" | "pollIntervalMs">,
): Promise<boolean> {
  if (platform === "win32") return taskkill(pid, timing.cleanupTimeoutMs);
  const deadline = performance.now() + timing.cleanupTimeoutMs;
  const grace = performance.now() + timing.cleanupTimeoutMs / 2;
  for (const [signal, until] of [
    ["SIGTERM", grace],
    ["SIGKILL", deadline],
  ] as const) {
    if (!signalGroup(pid, signal)) return true;
    while (performance.now() < until) {
      if (!signalGroup(pid, 0)) return true;
      await sleep(Math.min(timing.pollIntervalMs, until - performance.now()));
    }
  }
  return !signalGroup(pid, 0);
}

/** False once the group is gone. EPERM keeps it "present": only ESRCH proves absence. */
function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function taskkill(pid: number, timeoutMs: number): Promise<boolean> {
  const root = process.env.SystemRoot ?? "C:\\Windows";
  return new Promise((resolve) => {
    const killer = spawn(
      pathFor("win32").join(root, "System32", "taskkill.exe"),
      ["/T", "/F", "/PID", String(pid)],
      { stdio: "ignore", windowsHide: true, shell: false, timeout: timeoutMs },
    );
    killer.once("error", () => resolve(false));
    // 128: the process already exited, so there is nothing left to end.
    killer.once("exit", (code) => resolve(code === 0 || code === 128));
  });
}

/**
 * Runs the command directly, without a helper process. On POSIX it leads its own process group
 * (`detached`), so the whole group is ended on timeout, cancellation and normal exit alike.
 */
export function runProcessTree(
  plan: SpawnPlan,
  options: SpawnOptions,
  platform: Platform,
  supervision: SupervisionOptions,
  started: number,
): Promise<ProcessResult> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(plan.file, [...plan.args], {
      cwd: options.cwd,
      env: { ...options.env },
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: platform !== "win32",
      windowsHide: true,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
      shell: false,
    });
    const stdout = new StreamCapture(options.maxOutputBytes, options.capture),
      stderr = new StreamCapture(options.maxOutputBytes, options.capture);
    let failure: Error | undefined;
    const capture = (stream: StreamCapture, chunk: Buffer): void => {
      try {
        stream.push(chunk);
      } catch (error) {
        failure ??=
          error instanceof Error ? error : new Error("Output capture failed");
        void settle(true);
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => capture(stderr, chunk));
    if (options.stdin !== undefined) {
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(options.stdin);
    }
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    const closed = new Promise<void>((resolve) =>
      child.once("close", () => resolve()),
    );
    let pipesClosed = false;
    void closed.then(() => (pipesClosed = true));
    let timedOut = false,
      interrupted = false,
      settling = false;
    const within = async (
      pending: Promise<void>,
      ms: number,
    ): Promise<void> => {
      let wait: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        pending,
        new Promise<void>((resolve) => (wait = setTimeout(resolve, ms))),
      ]);
      clearTimeout(wait);
    };
    const settle = async (interrupt: boolean): Promise<void> => {
      if (settling) return;
      settling = true;
      interrupted = interrupt;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
      const pid = child.pid;
      // On Windows a tree whose root already exited has no parent links left to walk.
      const confirmed =
        pid === undefined ||
        (platform === "win32" && !interrupt) ||
        (await endProcessTree(pid, platform, supervision));
      if (pid !== undefined) {
        if (child.exitCode === null && child.signalCode === null)
          await within(exited, supervision.cleanupTimeoutMs);
        if (!pipesClosed) await within(closed, supervision.drainTimeoutMs);
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (
        !confirmed ||
        (pid !== undefined &&
          child.exitCode === null &&
          child.signalCode === null)
      )
        failure = new ProcessSpawnError(
          "TREE_KILL_FAILED",
          "The process tree could not be confirmed stopped",
          failure,
        );
      if (failure !== undefined) return rejectRun(failure);
      resolveRun({
        exitCode: interrupted ? null : child.exitCode,
        signal: interrupted ? "SIGKILL" : child.signalCode,
        stdout: stdout.text(),
        stderr: stderr.text(),
        timedOut,
        truncated: stdout.truncated || stderr.truncated,
        durationMs: Math.round(performance.now() - started),
        supervision: {
          mode: "supervised",
          backend: "process-group",
          supervisorPid: pid ?? 0,
          ...(pid === undefined ? {} : { commandPid: pid }),
          stoppedPids: pid === undefined ? [] : [pid],
          ...(pid !== undefined && platform !== "win32"
            ? { groupId: pid }
            : {}),
          confirmed: true,
          pidSnapshotComplete: false,
          supervisorResidentBytes: 0,
        },
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
    const cancel = (): void => void settle(true);
    const timer = setTimeout(
      () => {
        timedOut = true;
        cancel();
      },
      Math.max(1, options.timeoutMs - (performance.now() - started)),
    );
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    child.once("error", (cause) => {
      failure ??= new ProcessSpawnError(
        "SPAWN_FAILED",
        "Could not start command",
        cause,
      );
      void settle(false);
    });
    void exited.then(() => settle(false));
  });
}
