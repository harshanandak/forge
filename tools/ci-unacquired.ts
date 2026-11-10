import { parseDocument } from "yaml";

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
  event?: string;
  pull_requests?: readonly { base?: { sha?: string } }[];
};
const workflowByteLimit = 256 * 1024;
class WorkflowInputError extends Error {}

export async function readHeadWorkflow(
  endpoint: string,
  env: Readonly<Record<string, string | undefined>>,
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
  metadata = false,
): Promise<string> {
  const deadline = AbortSignal.timeout(10_000);
  const failedRead = (error: unknown): never => {
    if (deadline.aborted)
      throw new WorkflowInputError("Head CI workflow read timed out");
    throw error;
  };
  const response = await request(`https://api.github.com/${endpoint}`, {
    signal: deadline,
    headers: {
      Accept: metadata
        ? "application/vnd.github+json"
        : "application/vnd.github.raw+json",
      Authorization: `Bearer ${env.GH_TOKEN}`,
    },
  }).catch(failedRead);
  if (!response.ok || response.body === null)
    throw new Error("Head workflow unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read().catch(failedRead);
      if (next.done) break;
      const value: unknown = next.value;
      if (!(value instanceof Uint8Array))
        throw new Error("Invalid response chunk");
      size += value.byteLength;
      if (size > workflowByteLimit)
        throw new WorkflowInputError("Head CI workflow exceeds 256 KB");
      chunks.push(value);
    }
    return await new Blob(chunks).text();
  } finally {
    await reader.cancel().catch(failedRead);
    reader.releaseLock();
  }
}
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
  const document = parseDocument(ciWorkflow, {
    schema: "core",
    uniqueKeys: true,
    prettyErrors: false,
  });
  if (document.errors.length > 0 || document.warnings.length > 0)
    throw new WorkflowInputError(
      "Head CI workflow has YAML errors or warnings",
    );
  let workflow: unknown;
  try {
    workflow = document.toJS({ maxAliasCount: 32 });
  } catch {
    throw new WorkflowInputError(
      "Head CI workflow exceeds YAML alias limit or has invalid aliases",
    );
  }
  const jobs = (
    workflow as {
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
    if (
      countLegs &&
      (matchingPrefix(name).trim() === "" ||
        Object.entries(jobs ?? {}).some(([otherId, other]) => {
          if (otherId === id) return false;
          const otherName = other.name ?? otherId;
          return (
            typeof otherName !== "string" ||
            matchesName(name, matchingPrefix(otherName)) ||
            matchesName(otherName, matchingPrefix(name))
          );
        }))
    )
      throw new WorkflowInputError(
        "Head CI workflow has ambiguous job name prefixes",
      );
    return Array<string>(countLegs ? matrixSize(job.strategy?.matrix) : 1).fill(
      name,
    );
  });
}
// A matrix name is a template; match on the text before its first expression.
const matchingPrefix = (template: string) => template.split("${{", 1)[0] ?? "";
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
  read = (endpoint: string): Promise<string> =>
    readHeadWorkflow(endpoint, env, fetch, current.event === "pull_request"),
): Promise<string> {
  try {
    if (
      !/^[a-f0-9]{40}$/i.test(current.head_sha ?? "") ||
      !/^[\w.-]+\/[\w.-]+$/.test(env.GH_REPO ?? "")
    )
      throw new Error("Missing run source");
    const baseSha = current.pull_requests?.[0]?.base?.sha;
    if (
      current.event === "pull_request" &&
      !/^[a-f0-9]{40}$/i.test(baseSha ?? "")
    )
      throw new WorkflowInputError("Head CI workflow revision ambiguous");
    // Fork content is parsed as YAML data only. Trusted code stays on default branch.
    let workflow = await read(
      `repos/${env.GH_REPO}/contents/.github/workflows/ci.yml?ref=${current.head_sha}`,
    );
    if (current.event === "pull_request") {
      try {
        const head = JSON.parse(workflow) as {
          sha?: string;
          content?: string;
          encoding?: string;
        };
        const base = JSON.parse(
          await read(
            `repos/${env.GH_REPO}/contents/.github/workflows/ci.yml?ref=${baseSha}`,
          ),
        ) as { sha?: string };
        if (
          !/^[a-f0-9]{40}$/i.test(head.sha ?? "") ||
          head.sha !== base.sha ||
          head.encoding !== "base64" ||
          typeof head.content !== "string"
        )
          throw new Error("Different workflow blobs");
        workflow = Buffer.from(head.content, "base64").toString("utf8");
      } catch {
        throw new WorkflowInputError("Head CI workflow revision ambiguous");
      }
    }
    if (new TextEncoder().encode(workflow).byteLength > workflowByteLimit)
      throw new WorkflowInputError("Head CI workflow exceeds 256 KB");
    return decisionOutput(pages, current, env, workflow);
  } catch (error) {
    if (error instanceof WorkflowInputError)
      return `rerun=false\nscope=failed\nreason=${error.message}; keep CI failed`;
    if (error instanceof Error && error.name === "TimeoutError")
      return "rerun=false\nscope=failed\nreason=Head CI workflow read timed out; keep CI failed";
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
