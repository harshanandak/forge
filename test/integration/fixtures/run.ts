import { spawn } from "node:child_process";

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

/** Run at most `limit` items at once; every item settles before failures are thrown, so callers can clean up. */
export async function runBounded<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const output: R[] = [];
  const failures: unknown[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let index = next++; index < items.length; index = next++) {
        try {
          output[index] = await run(items[index]!, index);
        } catch (error) {
          failures.push(error);
        }
      }
    }),
  );
  if (failures.length) throw new AggregateError(failures, "Fixtures failed");
  return output;
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
