import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import type { ProcessResult, SpawnOptions } from "../../ports/process.ts";
import { captureStreams, type StreamCapture } from "./capture.ts";
import { ProcessSpawnError } from "./errors.ts";
import type { SpawnPlan } from "./plan.ts";
import type { SupervisionOptions } from "./supervision.ts";

type Kill = (pid: number, signal: NodeJS.Signals | 0) => void;

/** The time source the stop sequence paces itself by; tests pass one they advance themselves. */
export interface StopClock {
  now(): number;
  sleep(ms: number): Promise<unknown>;
}

const realClock: StopClock = { now: () => performance.now(), sleep };

/** Extra group SIGKILLs after the first, to catch a child forked while the first one landed. */
const SIGKILL_RESENDS = 3;
const SIGKILL_RESEND_INTERVAL_MS = 25;

/**
 * Ends the POSIX process group led by `pid`: SIGTERM the group, then SIGKILL whatever is left
 * after half the cleanup budget, re-sent a few times so a child forked mid-kill is caught. SIGKILL cannot be caught or ignored, so once the OS accepts
 * it for the group every member is dead; members still answering a signal-zero probe after that
 * are zombies waiting to be reaped and are not polled for. Resolves false only when a signal
 * could not be delivered for a reason other than the group being gone.
 *
 * macOS skips zombies when signalling a group and answers EPERM when no live member is left,
 * so a group whose members all died but are not yet reaped looks refused. A refusal is therefore
 * re-checked after `reaped` (the leader's exit) settles: once the leader is reaped the group
 * disappears (ESRCH) unless a live member really refuses the signal.
 */
export async function endProcessGroup(
  pid: number,
  timing: Pick<SupervisionOptions, "cleanupTimeoutMs" | "pollIntervalMs">,
  kill: Kill = (target, signal) => process.kill(target, signal),
  reaped: Promise<unknown> = Promise.resolve(),
  clock: StopClock = realClock,
): Promise<boolean> {
  const deadline = clock.now() + timing.cleanupTimeoutMs;
  const grace = deadline - timing.cleanupTimeoutMs / 2;
  let state = signalGroup(kill, pid, "SIGTERM");
  while (state === "present" && clock.now() < grace) {
    await clock.sleep(Math.min(timing.pollIntervalMs, grace - clock.now()));
    state = signalGroup(kill, pid, 0);
  }
  if (state === "gone") return true;
  state = signalGroup(kill, pid, "SIGKILL");
  // A member forking while the first SIGKILL lands can publish a child that misses it, so the
  // group is sent SIGKILL again a few times; ESRCH means it is gone. These are safety repeats,
  // not policy, and they stay inside the cleanup budget.
  let resends = 0;
  while (
    state === "refused" ||
    (state === "present" && resends < SIGKILL_RESENDS)
  ) {
    const left = deadline - clock.now();
    if (left <= 0) break;
    if (state === "refused") {
      await within(reaped, left);
      await clock.sleep(
        Math.min(timing.pollIntervalMs, Math.max(0, deadline - clock.now())),
      );
    } else {
      resends++;
      await clock.sleep(Math.min(SIGKILL_RESEND_INTERVAL_MS, left));
    }
    state = signalGroup(kill, pid, "SIGKILL");
  }
  return state === "present" || state === "gone";
}

/** Only ESRCH proves the group is gone; EPERM is a refusal, any other error a failure. */
function signalGroup(
  kill: Kill,
  pid: number,
  signal: NodeJS.Signals | 0,
): "present" | "gone" | "refused" | "failed" {
  try {
    kill(-pid, signal);
    return "present";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ESRCH" ? "gone" : code === "EPERM" ? "refused" : "failed";
  }
}

async function within(pending: Promise<unknown>, ms: number): Promise<void> {
  let wait: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    pending,
    new Promise<void>((resolve) => (wait = setTimeout(resolve, ms))),
  ]);
  clearTimeout(wait);
}

/**
 * Runs the command directly, without a helper process, on POSIX only. It leads its own process
 * group (`detached`), so the whole group is ended on timeout, cancellation and normal exit alike.
 * Windows keeps the helper and its Job Object: taskkill /T cannot reach a detached descendant
 * whose parent already exited.
 */
export function runProcessTree(
  plan: SpawnPlan,
  options: SpawnOptions,
  supervision: SupervisionOptions,
  started: number,
): Promise<ProcessResult> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(plan.file, [...plan.args], {
      cwd: options.cwd,
      env: { ...options.env },
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: true,
      shell: false,
    });
    const { stdout, stderr } = captureStreams(options);
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
    const settle = async (interrupt: boolean): Promise<void> => {
      if (settling) return;
      settling = true;
      interrupted = interrupt;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
      const pid = child.pid;
      const confirmed =
        pid === undefined ||
        (await endProcessGroup(pid, supervision, undefined, exited));
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
          ...(pid === undefined ? {} : { groupId: pid }),
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
