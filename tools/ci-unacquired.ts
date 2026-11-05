export type CiJob = {
  name: string;
  conclusion: string | null;
  runner_name: string | null;
  steps?: readonly unknown[];
};
export type CiRun = {
  conclusion: string | null;
  run_attempt: number;
  jobs: readonly CiJob[];
};
export type CurrentRun = {
  run_attempt: number;
  status: string;
  conclusion: string | null;
};
export function decideRerun(
  run: CiRun,
  current: CurrentRun,
): {
  rerun: boolean;
  reason: string;
} {
  if (run.conclusion !== "failure")
    return { rerun: false, reason: "CI run did not fail" };
  if (!(run.run_attempt < 3))
    return { rerun: false, reason: "Runner-allocation attempt limit reached" };
  if (
    current.run_attempt !== run.run_attempt ||
    current.status !== "completed" ||
    current.conclusion !== "failure"
  )
    return {
      rerun: false,
      reason: "Current run is no longer the judged failed attempt",
    };
  const unacquired = (job: CiJob) =>
    (job.conclusion === "cancelled" || job.conclusion === null) &&
    (job.steps?.length ?? 0) === 0 &&
    (job.runner_name === "" || job.runner_name === null);
  const rerun =
    run.jobs.some(unacquired) &&
    run.jobs.every(
      (job) =>
        job.conclusion === "success" ||
        job.conclusion === "skipped" ||
        unacquired(job) ||
        job.name === "CI Gate",
    );
  return {
    rerun,
    reason: rerun
      ? "Only skipped, never-acquired jobs and CI Gate are non-success; rerun failed jobs"
      : "Real failure or no never-acquired job; keep CI failed",
  };
}
if (import.meta.main) {
  const pages = (await Bun.stdin.json()) as { jobs: CiJob[] }[];
  const current = (await Bun.file(
    `${process.env.RUNNER_TEMP}/ci-current.json`,
  ).json()) as CurrentRun;
  const decision = decideRerun(
    {
      conclusion: process.env.RUN_CONCLUSION ?? null,
      run_attempt: Number(process.env.RUN_ATTEMPT),
      jobs: pages.flatMap((page) => page.jobs),
    },
    current,
  );
  console.log(`rerun=${decision.rerun}\nreason=${decision.reason}`);
}
