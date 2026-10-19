import { spawn } from "node:child_process";
import { runBounded } from "../../../tools/packed-pool.ts";

export type Fixture = {
  label: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
};

async function runFixture(fixture: Fixture, prefix: string): Promise<string> {
  const started = performance.now();
  try {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(fixture.command, fixture.args, {
        cwd: fixture.cwd,
        env: fixture.env,
        windowsHide: true,
        timeout: 90000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let error: Error | undefined;
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", (cause) => {
        error = cause;
      });
      child.once("close", (status) => {
        if (error || status !== 0)
          reject(
            new Error(
              `${fixture.label}: ${error?.message ?? `exited ${String(status)}`}\n${stdout}\n${stderr}`,
            ),
          );
        else resolve(stdout);
      });
    });
  } finally {
    console.log(
      `${prefix} ${fixture.label}: ${Math.round(performance.now() - started)} ms`,
    );
  }
}

export async function runFixtures(
  fixtures: readonly Fixture[],
  concurrency = 3,
  prefix = "Packed first slice",
): Promise<string[]> {
  // Every child must close before the caller can remove its fixture directories.
  return runBounded(fixtures, concurrency, (fixture) =>
    runFixture(fixture, prefix),
  );
}
