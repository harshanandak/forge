import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { ProcessResult, SpawnOptions } from "../../ports/process.ts";
import { ProcessSpawnError } from "./errors.ts";
import { planSpawn } from "./plan.ts";
import type { Platform } from "./platform.ts";
import { killTree } from "./tree-kill.ts";

/** After the process exits, wait this long for its output pipes before closing them ourselves. */
const DRAIN_GRACE_MS = 250;
/** After a timeout kill, give up waiting for the exit event after this long. */
const KILL_WAIT_MS = 5_000;
/** Node timers overflow above this. */
const MAX_TIMER_MS = 2_147_483_647;

/** Keeps the first `limit` bytes of one stream and counts the rest as dropped. */
class Capture {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  private readonly limit: number;
  truncated = false;

  constructor(limit: number) {
    this.limit = limit;
  }

  push(chunk: Buffer): void {
    const room = this.limit - this.size;
    if (room <= 0) {
      this.truncated = true;
      return;
    }
    if (chunk.length > room) {
      this.chunks.push(chunk.subarray(0, room));
      this.size += room;
      this.truncated = true;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

function validate(options: SpawnOptions): void {
  const bad = (what: string): never => {
    throw new ProcessSpawnError("INVALID_OPTIONS", what);
  };
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
    bad("timeoutMs must be a positive number of milliseconds.");
  if (!Number.isInteger(options.maxOutputBytes) || options.maxOutputBytes < 0)
    bad("maxOutputBytes must be a non-negative integer.");
  if (!existsSync(options.cwd))
    bad(`the working directory "${options.cwd}" does not exist.`);
  for (const [name, value] of Object.entries(options.env)) {
    if (typeof value !== "string" || name === "" || name.includes("="))
      bad(`environment entry "${name}" is not a plain name=string pair.`);
  }
}

/**
 * Run one resolved executable to completion with an argument array, capped output and a timeout
 * that stops the whole process tree. A command that starts and fails is a result; one that cannot
 * start rejects with ProcessSpawnError. The child gets exactly `options.env` and no console window.
 * Each of stdout and stderr keeps its first `maxOutputBytes` bytes.
 */
export function runProcess(
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
  platform: Platform,
): Promise<ProcessResult> {
  validate(options);
  if (options.signal?.aborted)
    return Promise.reject(
      new ProcessSpawnError(
        "INVALID_OPTIONS",
        "Process invocation is cancelled.",
      ),
    );
  const plan = planSpawn(executable, args, options.env, platform);
  const started = performance.now();

  return new Promise<ProcessResult>((resolveRun, rejectRun) => {
    let child;
    try {
      child = spawn(plan.file, [...plan.args], {
        cwd: options.cwd,
        env: { ...options.env },
        stdio: [
          options.stdin === undefined ? "ignore" : "pipe",
          "pipe",
          "pipe",
        ],
        windowsHide: true,
        windowsVerbatimArguments: plan.windowsVerbatimArguments,
        detached: platform !== "win32",
        shell: false,
      });
    } catch (cause) {
      rejectRun(
        new ProcessSpawnError(
          "SPAWN_FAILED",
          `Could not start "${executable}".`,
          cause,
        ),
      );
      return;
    }

    const stdout = new Capture(options.maxOutputBytes);
    const stderr = new Capture(options.maxOutputBytes);
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    if (options.stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => {
        // the child closed its input early; its exit status says what happened
      });
      child.stdin.end(options.stdin);
    }

    let timedOut = false;
    let settled = false;
    let exit: { code: number | null; signal: string | null } | undefined;
    let killWait: ReturnType<typeof setTimeout> | undefined;
    let drain: ReturnType<typeof setTimeout> | undefined;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", cancel);
      if (killWait !== undefined) clearTimeout(killWait);
      if (drain !== undefined) clearTimeout(drain);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolveRun({
        exitCode: timedOut ? null : (exit?.code ?? null),
        signal: timedOut ? (exit?.signal ?? "SIGKILL") : (exit?.signal ?? null),
        stdout: stdout.text(),
        stderr: stderr.text(),
        timedOut,
        truncated: stdout.truncated || stderr.truncated,
        durationMs: Math.round(performance.now() - started),
      });
    };

    const stop = (): void => {
      if (settled || killWait !== undefined) return;
      if (child.pid !== undefined) killTree(child.pid, platform, options.env);
      killWait = setTimeout(finish, KILL_WAIT_MS);
    };
    const cancel = (): void => {
      stop();
    };
    const timeout = setTimeout(
      () => {
        timedOut = true;
        stop();
      },
      Math.min(options.timeoutMs, MAX_TIMER_MS),
    );
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();

    child.once("error", (cause) => {
      if (child.pid === undefined && !settled) {
        settled = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", cancel);
        rejectRun(
          new ProcessSpawnError(
            "SPAWN_FAILED",
            `Could not start "${executable}": ${cause.message}`,
            cause,
          ),
        );
      }
    });
    child.once("exit", (code, signal) => {
      exit = { code, signal };
      drain = setTimeout(finish, DRAIN_GRACE_MS);
    });
    child.once("close", finish);
  });
}
