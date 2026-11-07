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
            new Error(
              `PowerShell ${timedOut ? "timeout" : `exit ${status}`}; phase=${phases.commandStart ? "command" : phases.firstOutput ? "startup-output" : "startup"}; case=${phases.case ?? "pending"}; ${JSON.stringify(phases)}; ${stderr}`,
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

/** One launch per batch; emitted commands remain verbatim inside isolated script blocks. */
export function powerShellBatch(launch: PowerShellSpawn = spawn) {
  let launches = 0;
  return {
    get launches() {
      return launches;
    },
    async run(
      shell: string,
      cases: readonly { name: string; command: string }[],
      timeout: number,
    ) {
      const script = cases
        .map(
          ({ command }, index) =>
            `[Console]::Out.WriteLine('FORGE_CASE_START:${index}'); & {\n${command}\n}; $caseStatus = [int](-not $?); [Console]::Out.WriteLine('FORGE_CASE_END:${index}:' + $caseStatus)`,
        )
        .join("\n");
      launches += 1;
      const run = await powerShellStep(
        shell,
        script,
        timeout,
        cases.map(({ name }) => name),
        launch,
      );
      return cases.map(({ name }, index) => {
        const match = new RegExp(
          `FORGE_CASE_START:${index}\\r?\\n([\\s\\S]*?)FORGE_CASE_END:${index}:([01])\\r?\\n`,
        ).exec(run.stdout);
        if (match === null)
          throw new Error(`PowerShell case did not complete: ${name}`);
        return { ...run, name, stdout: match[1]!, status: Number(match[2]) };
      });
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
