import { runChild, type ChildRunnerPort } from "./child-runner.ts";
import type { RunnerPolicy } from "./runner-policy.ts";

export interface StepChild {
  readonly label: string;
  readonly executable: string;
  readonly args: readonly string[];
}

/** The step cancels siblings on first failure and drains their bounded cleanup. */
export async function runStep(
  jobs: readonly StepChild[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  policy: RunnerPolicy,
  port?: ChildRunnerPort,
  output: (stream: "stdout" | "stderr", value: string) => void = (
    stream,
    value,
  ) => {
    (stream === "stdout" ? process.stdout : process.stderr).write(value);
  },
): Promise<void> {
  const scope = new AbortController();
  const expired = () =>
    scope.abort(
      new Error(`step deadline exceeded after ${policy.stepTimeoutMs} ms`),
    );
  const timer =
    port === undefined ? setTimeout(expired, policy.stepTimeoutMs) : undefined;
  const cancel =
    port?.schedule(policy.stepTimeoutMs, expired) ??
    (() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  try {
    const results = await Promise.allSettled(
      jobs.map(async (job) => {
        console.log(
          `START ${job.label} (child bound ${policy.childTimeoutMs} ms)`,
        );
        try {
          await runChild(
            job.label,
            job.executable,
            job.args,
            {
              cwd,
              env: { ...env, FORGE_RUNNER_GROUP_SCOPE: "inherited" },
              timeoutMs: policy.childTimeoutMs,
              cleanupTimeoutMs: policy.cleanupTimeoutMs,
              maxOutputBytes: policy.maxOutputBytes,
              signal: scope.signal,
              onOutput: output,
            },
            port,
          );
          console.log(`PASS ${job.label}`);
        } catch (error) {
          console.error(error instanceof Error ? error.message : String(error));
          scope.abort(error);
          throw error;
        }
      }),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        `integration and smoke step failed: ${scope.signal.reason instanceof Error ? scope.signal.reason.message : "child failure"}`,
      );
  } finally {
    cancel();
  }
}
