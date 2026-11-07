import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { powerShellArgs } from "./powershell.ts";

type PowerShellSpawn = (
  shell: string,
  args: string[],
  options: { windowsHide: boolean },
) => EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill(): unknown;
};

export async function powerShellStep(
  shell: string,
  command: string,
  timeout: number,
  caseNames: readonly string[] = [],
  launch: PowerShellSpawn = spawn,
) {
  const phases: Record<string, string | undefined> = {
    spawn: new Date().toISOString(),
  };
  let stdout = "",
    stderr = "";
  const marker = "FORGE_COMMAND_START:";
  const child = launch(
    shell,
    powerShellArgs(
      `[Console]::Out.WriteLine('${marker}' + [DateTime]::UtcNow.ToString('o'));\n${command}`,
    ),
    { windowsHide: true },
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeout);
  try {
    await new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.stdout.on("data", (data: Buffer) => {
        phases.firstOutput ??= new Date().toISOString();
        stdout += data.toString();
        phases.commandStart ??= new RegExp(`${marker}([^\\r\\n]+)`).exec(
          stdout,
        )?.[1];
        for (const match of stdout.matchAll(/FORGE_CASE_START:(\d+)\r?\n/g))
          phases.case = caseNames[Number(match[1])];
      });
      child.stderr.on("data", (data: Buffer) => {
        phases.firstOutput ??= new Date().toISOString();
        stderr += data.toString();
      });
      child.on("close", (status) => {
        phases.exit = new Date().toISOString();
        if (status === 0 && !timedOut) resolve();
        else
          reject(
            Object.assign(
              new Error(
                `PowerShell ${timedOut ? "timeout" : `exit ${status}`}; phase=${phases.commandStart ? "command" : phases.firstOutput ? "startup-output" : "startup"}; case=${phases.case ?? "pending"}; ${JSON.stringify(phases)}; ${stderr}`,
              ),
              { stdout, stderr, timedOut },
            ),
          );
      });
    });
    return {
      status: 0,
      stdout: stdout.replace(new RegExp(`${marker}[^\\r\\n]*\\r?\\n`), ""),
      stderr,
    };
  } finally {
    clearTimeout(timer);
  }
}

type BatchCase = { name: string; command: string };
type CaseOutcome = {
  name: string;
  status: number;
  stdout: string;
  stderr: string;
  /** Why a case failed without a status of its own: its launch timed out or exited, or it never ran. */
  reason?: "timeout" | "exit" | "not-run";
};

function batchScript(cases: readonly BatchCase[]) {
  return cases
    .map(
      ({ command }, index) =>
        `[Console]::Out.WriteLine('FORGE_CASE_START:${index}'); & {\n${command}\n}; $caseStatus = [int](-not $?); [Console]::Out.WriteLine('FORGE_CASE_END:${index}:' + $caseStatus)`,
    )
    .join("\n");
}

/** The finished case `index` in a batch's output, or undefined when it never reached its end marker. */
function finishedCase(index: number, stdout: string) {
  const match = new RegExp(
    `FORGE_CASE_START:${index}\\r?\\n([\\s\\S]*?)FORGE_CASE_END:${index}:([01])\\r?\\n`,
  ).exec(stdout);
  return match === null
    ? undefined
    : { stdout: match[1]!, status: Number(match[2]) };
}

/** One launch per batch; emitted commands remain verbatim inside isolated script blocks. */
export function powerShellBatch(
  launch: PowerShellSpawn = spawn,
  now: () => number = () => performance.now(),
) {
  let launches = 0;
  return {
    get launches() {
      return launches;
    },
    async run(shell: string, cases: readonly BatchCase[], timeout: number) {
      launches += 1;
      const run = await powerShellStep(
        shell,
        batchScript(cases),
        timeout,
        cases.map(({ name }) => name),
        launch,
      );
      return cases.map(({ name }, index) => {
        const done = finishedCase(index, run.stdout);
        if (done === undefined)
          throw new Error(`PowerShell case did not complete: ${name}`);
        return { ...run, name, ...done };
      });
    },
    /**
     * One outcome per case, in order, inside ONE wall-clock budget equal to `timeout` (the same
     * worst case as `run`). A launch that stalls or dies fails only the case it was running
     * (status -1, `reason` "timeout" or "exit", stderr holds the message). The cases before it keep
     * their results; the cases after it run in a fresh launch that gets only the budget left.
     * When the budget is spent they are reported as `reason: "not-run"` (status -1), never as
     * passes, and no launch starts for them.
     */
    async runEach(
      shell: string,
      cases: readonly BatchCase[],
      timeout: number,
    ): Promise<CaseOutcome[]> {
      const started = now();
      const outcomes: CaseOutcome[] = [];
      let pending = cases;
      while (pending.length > 0) {
        const current = pending;
        const remaining = timeout - (now() - started);
        if (remaining <= 0) {
          const after = outcomes.at(-1);
          const why = after
            ? ` (after ${after.name} ${after.reason === "timeout" ? "stalled" : "failed"})`
            : "";
          for (const { name } of current)
            outcomes.push({
              name,
              status: -1,
              stdout: "",
              stderr: `deadline exhausted; not run${why}`,
              reason: "not-run",
            });
          break;
        }
        launches += 1;
        let stdout: string;
        let stderr: string;
        let failure: (Error & { timedOut?: boolean }) | undefined;
        try {
          ({ stdout, stderr } = await powerShellStep(
            shell,
            batchScript(current),
            remaining,
            current.map(({ name }) => name),
            launch,
          ));
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          const partial = error as Error & {
            stdout?: string;
            stderr?: string;
            timedOut?: boolean;
          };
          failure = partial;
          stdout = partial.stdout ?? "";
          stderr = partial.stderr ?? "";
        }
        const reason = failure?.timedOut ? "timeout" : "exit";
        let finished = 0;
        for (const { name } of current) {
          const done = finishedCase(finished, stdout);
          if (done === undefined) break;
          outcomes.push({ name, stderr, ...done });
          finished += 1;
        }
        if (finished === current.length) {
          // Every case printed its end marker, but the launch itself failed: report it on the
          // last case, as `run` would have thrown it.
          if (failure !== undefined) {
            const last = outcomes.at(-1)!;
            outcomes[outcomes.length - 1] = {
              ...last,
              status: last.status === 0 ? -1 : last.status,
              stderr: failure.message,
              reason,
            };
          }
          break;
        }
        outcomes.push({
          name: current[finished]!.name,
          status: -1,
          stdout: "",
          stderr:
            failure?.message ??
            `PowerShell case did not complete: ${current[finished]!.name}`,
          reason,
        });
        pending = current.slice(finished + 1);
      }
      return outcomes;
    },
  };
}

export async function childStep<T>(
  name: string,
  run: () => T | Promise<T>,
  cleanup?: () => void | Promise<void>,
): Promise<T> {
  const started = performance.now();
  let value: { result: T } | undefined;
  let failure: { cause: unknown } | undefined;
  try {
    value = { result: await run() };
  } catch (cause) {
    failure = { cause };
  }
  let cleanupFailure: { cause: unknown } | undefined;
  try {
    await cleanup?.();
  } catch (cause) {
    cleanupFailure = { cause };
  }
  if (failure || cleanupFailure) {
    const cause = (failure ?? cleanupFailure)!.cause;
    const detail = cause instanceof Error ? cause.message : String(cause);
    const cleanupDetail =
      failure && cleanupFailure
        ? `\nCleanup failed: ${String(cleanupFailure.cause)}`
        : "";
    throw new Error(
      `${name} after ${Math.round(performance.now() - started)} ms: ${detail}${cleanupDetail}`,
      { cause },
    );
  }
  return value!.result;
}
