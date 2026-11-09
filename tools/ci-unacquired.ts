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
// Name templates of the jobs the CI Gate needs, read from the workflow itself
// so the list cannot drift from the gate's `needs`.
export function neededJobNames(ciWorkflow: string): string[] {
  const jobs = (
    Bun.YAML.parse(ciWorkflow) as {
      jobs?: Record<string, { name?: string; needs?: string | string[] }>;
    }
  ).jobs;
  const needs = jobs?.["ci-gate"]?.needs;
  if (needs === undefined) throw new Error("ci-gate has no needs");
  return [needs].flat().map((id) => {
    const job = jobs?.[id];
    if (job === undefined) throw new Error(`ci-gate needs unknown job ${id}`);
    return job.name ?? id;
  });
}
// A matrix name is a template; match on the text before its first expression.
const matchesName = (template: string, name: string) => {
  const cut = template.indexOf("${{");
  return cut < 0 ? name === template : name.startsWith(template.slice(0, cut));
};
export function decideRerun(
  run: CiRun,
  current: CurrentRun,
  needed: readonly string[] = [],
): {
  rerun: boolean;
  reason: string;
  scope: "failed" | "all";
} {
  if (run.conclusion !== "failure")
    return { rerun: false, reason: "CI run did not fail", scope: "failed" };
  if (!(run.run_attempt < 3))
    return {
      rerun: false,
      reason: "Runner-allocation attempt limit reached",
      scope: "failed",
    };
  if (
    current.run_attempt !== run.run_attempt ||
    current.status !== "completed" ||
    current.conclusion !== "failure"
  )
    return {
      rerun: false,
      reason: "Current run is no longer the judged failed attempt",
      scope: "failed",
    };
  const unacquired = (job: CiJob) =>
    (job.conclusion === "cancelled" || job.conclusion === null) &&
    (job.steps?.length ?? 0) === 0 &&
    (job.runner_name === "" || job.runner_name === null);
  const missing = needed.filter(
    (template) => !run.jobs.some((job) => matchesName(template, job.name)),
  );
  const hasGate = run.jobs.some((job) => job.name === "CI Gate");
  const rerun =
    (run.jobs.some(unacquired) || (missing.length > 0 && hasGate)) &&
    run.jobs.every(
      (job) =>
        job.conclusion === "success" ||
        job.conclusion === "skipped" ||
        unacquired(job) ||
        job.name === "CI Gate",
    );
  if (rerun && missing.length > 0)
    return {
      rerun,
      scope: "all",
      reason:
        "Needed jobs were never created and no job failed; rerun the whole run",
    };
  return {
    rerun,
    scope: "failed",
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
