import type { ProcessResult, SpawnOptions } from "../../ports/process.ts";
import { constants } from "node:os";
import { captureStreams } from "./capture.ts";
import { ProcessSpawnError } from "./errors.ts";
import type { SpawnPlan } from "./plan.ts";
import { endProcessGroup } from "./process-tree.ts";
import type { SupervisionOptions } from "./supervision.ts";

async function within(pending: Promise<unknown>, ms: number): Promise<void> {
  let wait: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    pending,
    new Promise<void>((resolve) => (wait = setTimeout(resolve, ms))),
  ]);
  clearTimeout(wait);
}

/** Native completion and readers avoid Bun's lost child_process events (forge-828). */
export async function runBunProcessTree(
  plan: SpawnPlan,
  options: SpawnOptions,
  supervision: SupervisionOptions,
  started: number,
): Promise<ProcessResult> {
  const { spawn } = (globalThis as unknown as { Bun: typeof import("bun") })
    .Bun;
  const spawned = performance.now();
  const now = () => performance.now() - spawned;
  const timeline: Record<string, number | string | null> = {};
  const captures = captureStreams(options);
  let child;
  try {
    child = spawn([plan.file, ...plan.args], {
      cwd: options.cwd,
      env: { ...options.env },
      stdio: [
        options.stdin === undefined ? "ignore" : Buffer.from(options.stdin),
        "pipe",
        "pipe",
      ],
      // Bun 1.4.4 implements detached with POSIX_SPAWN_SETSID, without a helper binary.
      detached: true,
    });
  } catch (cause) {
    throw new ProcessSpawnError(
      "SPAWN_FAILED",
      "Could not start command",
      cause,
    );
  }
  timeline.spawn = now();
  const bytes = { stdout: 0, stderr: 0 };
  const ended = { stdout: false, stderr: false };
  let failure: Error | undefined;
  let diagnostics: ProcessResult["diagnostics"];
  let timedOut = false,
    reading = true;
  const stopped = Promise.withResolvers<boolean>();
  const cancel = (): void => stopped.resolve(true);
  const fail = (cause: unknown): void => {
    failure ??=
      cause instanceof Error ? cause : new Error("Output capture failed");
    cancel();
  };
  const timer = setTimeout(
    () => {
      timedOut = true;
      diagnostics = {
        backend: "bun-spawn",
        exitCode: child.exitCode,
        signalCode: child.signalCode,
        killed: child.killed,
        stdoutReadableEnded: ended.stdout,
        stderrReadableEnded: ended.stderr,
        stdoutBytes: bytes.stdout,
        stderrBytes: bytes.stderr,
        timeline: { ...timeline },
      };
      cancel();
    },
    Math.max(1, options.timeoutMs - (performance.now() - started)),
  );
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const readers = {
    stdout: child.stdout.getReader(),
    stderr: child.stderr.getReader(),
  };
  const drained = Promise.all(
    (["stdout", "stderr"] as const).map(async (name) => {
      try {
        while (reading) {
          const { done, value } = await readers[name].read();
          if (!reading) break;
          if (done) {
            ended[name] = true;
            timeline[`${name}End`] = now();
            if (ended.stdout && ended.stderr) timeline.close = now();
            break;
          }
          if (value.length) timeline[`${name}FirstData`] ??= now();
          bytes[name] += value.length;
          captures[name].push(Buffer.from(value));
        }
      } catch (cause) {
        fail(cause);
      } finally {
        readers[name].releaseLock();
      }
    }),
  );
  const reaped = child.exited.then(
    () => {
      timeline.exit = now();
    },
    (cause: unknown) =>
      fail(
        new ProcessSpawnError("SPAWN_FAILED", "Could not start command", cause),
      ),
  );
  const interrupted = await Promise.race([
    reaped.then(() => false),
    stopped.promise,
  ]);
  clearTimeout(timer);
  options.signal?.removeEventListener("abort", cancel);
  const confirmed = await endProcessGroup(
    child.pid,
    supervision,
    undefined,
    reaped,
  );
  if (child.exitCode === null && child.signalCode === null)
    await within(reaped, supervision.cleanupTimeoutMs);
  await within(drained, supervision.drainTimeoutMs);
  const pipesClosed = ended.stdout && ended.stderr;
  reading = false;
  for (const name of ["stdout", "stderr"] as const)
    if (!ended[name]) void readers[name].cancel().catch(() => undefined);
  if (!confirmed || (child.exitCode === null && child.signalCode === null))
    throw new ProcessSpawnError(
      "TREE_KILL_FAILED",
      "The process tree could not be confirmed stopped",
      failure,
    );
  if (failure !== undefined) throw failure;
  const { stdout, stderr } = captures;
  const signal =
    typeof child.signalCode === "number"
      ? (Object.entries(constants.signals).find(
          ([, value]) => value === child.signalCode,
        )?.[0] ?? String(child.signalCode))
      : child.signalCode;
  const outputEvidence = options.capture && {
    stdout: stdout.evidence(pipesClosed),
    stderr: stderr.evidence(pipesClosed),
  };
  return {
    exitCode: interrupted ? null : child.exitCode,
    signal: interrupted ? "SIGKILL" : signal,
    stdout: stdout.text(),
    stderr: stderr.text(),
    timedOut,
    truncated: !pipesClosed || stdout.truncated || stderr.truncated,
    durationMs: Math.round(performance.now() - started),
    ...(diagnostics === undefined ? {} : { diagnostics }),
    supervision: {
      mode: "supervised",
      backend: "process-group",
      supervisorPid: child.pid,
      commandPid: child.pid,
      stoppedPids: [child.pid],
      groupId: child.pid,
      confirmed: true,
      pidSnapshotComplete: false,
      supervisorResidentBytes: 0,
    },
    ...(outputEvidence ? { outputEvidence } : {}),
  };
}
