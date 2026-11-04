import { spawn } from "node:child_process";

export async function powerShellStep(
  shell: string,
  command: string,
  timeout: number,
) {
  const phases: Record<string, string | undefined> = {
    spawn: new Date().toISOString(),
  };
  let stdout = "",
    stderr = "";
  const marker = "FORGE_COMMAND_START:";
  const child = spawn(
    shell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `[Console]::Out.WriteLine('${marker}' + [DateTime]::UtcNow.ToString('o'));\n${command}`,
    ],
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
              `PowerShell ${timedOut ? "timeout" : `exit ${status}`}; phase=${phases.commandStart ? "command" : phases.firstOutput ? "startup-output" : "startup"}; ${JSON.stringify(phases)}; ${stderr}`,
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
