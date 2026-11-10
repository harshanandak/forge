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
  head_sha?: string;
};
// Only static axes or an include-only matrix have an unambiguous count here.
function matrixSize(matrix: unknown): number {
  if (matrix === undefined) return 1;
  if (matrix === null || typeof matrix !== "object" || Array.isArray(matrix))
    throw new Error("Unsupported matrix");
  const entries = Object.entries(matrix);
  const literal = (value: unknown) =>
    typeof value === "number" ||
    typeof value === "boolean" ||
    (typeof value === "string" && !value.includes("${{"));
  let count: number;
  if (entries.length === 1 && entries[0]?.[0] === "include") {
    const rows: unknown = entries[0][1];
    if (
      !Array.isArray(rows) ||
      !rows.every(
        (row: unknown) =>
          row !== null &&
          typeof row === "object" &&
          !Array.isArray(row) &&
          Object.keys(row).length > 0 &&
          Object.values(row).every(literal),
      )
    )
      throw new Error("Unsupported matrix include");
    count = rows.length;
  } else {
    count = 1;
    for (const [key, values] of entries) {
      if (
        key === "include" ||
        key === "exclude" ||
        !Array.isArray(values) ||
        !values.every(literal)
      )
        throw new Error("Unsupported matrix axis");
      count *= values.length;
    }
  }
  if (entries.length === 0 || count < 1 || count > 256)
    throw new Error("Unsupported matrix size");
  return count;
}
// Name templates of the jobs the CI Gate needs, read from the workflow itself
// so the list cannot drift from the gate's `needs`.
export function neededJobNames(
  ciWorkflow: string,
  countLegs = false,
): string[] {
  const jobs = (
    Bun.YAML.parse(ciWorkflow) as {
      jobs?: Record<
        string,
        {
          name?: string;
          needs?: string | string[];
          strategy?: { matrix?: unknown };
        }
      >;
    }
  ).jobs;
  const needs = jobs?.["ci-gate"]?.needs;
  if (needs === undefined) throw new Error("ci-gate has no needs");
  return [needs].flat().flatMap((id) => {
    const job = jobs?.[id];
    if (job === undefined) throw new Error(`ci-gate needs unknown job ${id}`);
    const name = job.name ?? id;
    if (typeof name !== "string" || name.length === 0)
      throw new Error("Unsupported job name");
    return Array<string>(countLegs ? matrixSize(job.strategy?.matrix) : 1).fill(
      name,
    );
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
  const missing = needed.filter((template) => {
    const created = run.jobs.filter((job) => matchesName(template, job.name));
    // An if-skipped matrix has one unexpanded placeholder, not missing legs.
    return (
      !created.some(
        (job) => job.name === template && job.conclusion === "skipped",
      ) && created.length < needed.filter((name) => name === template).length
    );
  });
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
// The text the workflow reads: rerun=, scope= and reason= lines.
export function decisionOutput(
  pages: readonly { jobs: readonly CiJob[] }[],
  current: CurrentRun,
  env: Readonly<Record<string, string | undefined>>,
  ciWorkflow: string,
): string {
  const decision = decideRerun(
    {
      conclusion: env.RUN_CONCLUSION ?? null,
      run_attempt: Number(env.RUN_ATTEMPT),
      jobs: pages.flatMap((page) => page.jobs),
    },
    current,
    neededJobNames(ciWorkflow, true),
  );
  return `rerun=${decision.rerun}\nscope=${decision.scope}\nreason=${decision.reason}`;
}
export async function decisionAtHead(
  pages: readonly { jobs: readonly CiJob[] }[],
  current: CurrentRun,
  env: Readonly<Record<string, string | undefined>>,
  read = async (endpoint: string): Promise<string> => {
    const response = await fetch(`https://api.github.com/${endpoint}`, {
      headers: {
        Accept: "application/vnd.github.raw+json",
        Authorization: `Bearer ${env.GH_TOKEN}`,
      },
    });
    if (!response.ok) throw new Error("Head workflow unavailable");
    return response.text();
  },
): Promise<string> {
  try {
    if (
      !/^[a-f0-9]{40}$/i.test(current.head_sha ?? "") ||
      !/^[\w.-]+\/[\w.-]+$/.test(env.GH_REPO ?? "")
    )
      throw new Error("Missing run source");
    // Fork content is parsed as YAML data only. Trusted code stays on default branch.
    const workflow = await read(
      `repos/${env.GH_REPO}/contents/.github/workflows/ci.yml?ref=${current.head_sha}`,
    );
    return decisionOutput(pages, current, env, workflow);
  } catch {
    return "rerun=false\nscope=failed\nreason=Head CI workflow could not be read or interpreted; keep CI failed";
  }
}
if (import.meta.main) {
  console.log(
    await decisionAtHead(
      (await Bun.stdin.json()) as { jobs: CiJob[] }[],
      (await Bun.file(
        `${process.env.RUNNER_TEMP}/ci-current.json`,
      ).json()) as CurrentRun,
      process.env,
    ),
  );
}
