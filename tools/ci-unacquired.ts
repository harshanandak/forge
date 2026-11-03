export type CiJob = {
  name: string;
  conclusion: string | null;
  runner_name: string;
  steps: readonly unknown[];
};
export type CiRun = {
  conclusion: string | null;
  run_attempt: number;
  jobs: readonly CiJob[];
};
export function decideRerun(run: CiRun): {
  rerun: boolean;
  reason: string;
} {
  if (run.conclusion !== "failure")
    return { rerun: false, reason: "CI run did not fail" };
  if (!(run.run_attempt < 3))
    return { rerun: false, reason: "Runner-allocation attempt limit reached" };
  const unacquired = (job: CiJob) =>
    job.conclusion === "cancelled" &&
    job.steps.length === 0 &&
    job.runner_name === "";
  const rerun =
    run.jobs.some(unacquired) &&
    run.jobs.every(
      (job) =>
        job.conclusion === "success" ||
        unacquired(job) ||
        job.name === "CI Gate",
    );
  return {
    rerun,
    reason: rerun
      ? "Only never-acquired jobs and CI Gate are non-success; rerun failed jobs"
      : "Real failure or no never-acquired job; keep CI failed",
  };
}
if (import.meta.main) {
  const pages = (await Bun.stdin.json()) as { jobs: CiJob[] }[];
  const decision = decideRerun({
    conclusion: process.env.RUN_CONCLUSION ?? null,
    run_attempt: Number(process.env.RUN_ATTEMPT),
    jobs: pages.flatMap((page) => page.jobs),
  });
  console.log(`rerun=${decision.rerun}\nreason=${decision.reason}`);
}
