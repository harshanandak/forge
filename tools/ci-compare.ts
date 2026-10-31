import { runCommand } from "./run-command.ts";

type Job = {
  databaseId: number;
  name: string;
  conclusion: string;
  steps: { name: string; conclusion: string }[];
};
type Run = { databaseId: number; headSha: string };
type Workflow = { workflowDatabaseId: number; jobs: Job[] };
type Check = { name: string; conclusion?: string; detailsUrl?: string };
const failed = (value: string) =>
  ["failure", "timed_out"].includes(value.toLowerCase());
const firstStep = (job: Job | undefined) =>
  job?.steps.find((step) => failed(step.conclusion))?.name || null;
let token = "";
let host = "";
const redact = (text: string) =>
  token ? text.replaceAll(token, "[redacted]") : text;
function command(program: string, args: string[], auth = false): string {
  const executable = Bun.which(program);
  if (!executable) throw new Error(`${program} is unavailable on PATH`);
  const env: NodeJS.ProcessEnv = { ...process.env, GH_HOST: host };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  if (!auth) env.GH_TOKEN = token;
  const result = runCommand(program === "gh" ? program : executable, args, {
    env,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      redact(
        result.stderr?.trim() ||
          result.error?.message ||
          `${program} exited ${result.status}`,
      ),
    );
  return result.stdout.trim();
}
function compare(pr: string) {
  if (!/^[1-9]\d*$/.test(pr) || process.argv.length !== 3)
    throw new Error("Usage: bun tools/ci-compare.ts <pr-number>");
  const user = process.env.FORGE_GH_USER;
  if (!user)
    throw new Error("FORGE_GH_USER must name the configured GitHub account");
  const origin =
    /^(?:https:\/\/|ssh:\/\/git@|git@)(github\.com)[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(
      command("git", ["remote", "get-url", "origin"]),
    );
  if (!origin) throw new Error("origin must be a GitHub repository URL");
  host = origin[1]!;
  const repo = origin[2]!;
  token = command(
    "gh",
    ["auth", "token", "--user", user, "--hostname", host],
    true,
  );
  if (!token) throw new Error("gh auth token returned no token");
  const gh = <T>(args: string[]): T =>
    JSON.parse(command("gh", [...args, "--repo", repo])) as T;
  const view = <T>(id: string, fields: string) =>
    gh<T>(["run", "view", id, "--json", fields]);
  const head = gh<{ headRefOid: string; statusCheckRollup: Check[] }>([
    "pr",
    "view",
    pr,
    "--json",
    "headRefOid,statusCheckRollup",
  ]);
  const checks = head.statusCheckRollup ?? [];
  const failures = checks.filter((check) => failed(check.conclusion ?? ""));
  let mainHead: string | null = null,
    mainError: string | undefined;
  if (failures.length) {
    try {
      mainHead = command("git", ["rev-parse", "origin/main"]);
    } catch {
      mainError = "origin/main is unavailable in this checkout";
    }
  }
  const cancelled = checks
    .filter((check) => check.conclusion?.toLowerCase() === "cancelled")
    .map((check) => ({
      name: check.name,
      conclusion: "cancelled",
      url: check.detailsUrl ?? null,
    }));
  const prRuns = new Map<string, Workflow>();
  const mainRuns = new Map<number, { run: Run | undefined; jobs: Job[] }>();
  const comparisons = failures.map((check) => {
    const runId = /\/actions\/runs\/(\d+)/.exec(check.detailsUrl ?? "")?.[1];
    const jobId = /\/job\/(\d+)(?:[/?#]|$)/.exec(check.detailsUrl ?? "")?.[1];
    let prJob: Job | undefined,
      mainJob: Job | undefined,
      mainRun: Run | undefined;
    let reason = mainError;
    if (!runId || !jobId)
      reason ??= "PR job cannot be identified from its GitHub Actions URL";
    if (runId && jobId) {
      let source = prRuns.get(runId);
      if (!source) {
        source = view<Workflow>(runId, "workflowDatabaseId,jobs");
        prRuns.set(runId, source);
      }
      prJob = source.jobs.find((job) => String(job.databaseId) === jobId);
      if (!prJob) reason ??= "PR job ID is absent from the PR run";
      else if (!reason) {
        let baseline = mainRuns.get(source.workflowDatabaseId);
        if (!baseline) {
          const args = [
            "run",
            "list",
            "--branch=main",
            `--workflow=${source.workflowDatabaseId}`,
            "--status=completed",
            "--limit=1",
            "--json=databaseId,headSha",
          ];
          const run =
            gh<Run[]>([...args, "--commit", mainHead!])[0] ??
            gh<Run[]>(args)[0];
          baseline = {
            run,
            jobs: run
              ? view<{ jobs: Job[] }>(String(run.databaseId), "jobs").jobs
              : [],
          };
          mainRuns.set(source.workflowDatabaseId, baseline);
        }
        mainRun = baseline.run;
        const matches = baseline.jobs.filter((job) => job.name === check.name);
        mainJob = matches.length === 1 ? matches[0] : undefined;
        if (!mainRun) reason = "No completed run for this workflow on main";
        else if (!mainJob)
          reason = matches.length
            ? "Multiple same-named jobs on main"
            : "No same-named job in the main run";
      }
    }
    const prStep = firstStep(prJob),
      mainStep = firstStep(mainJob);
    let verdict = "main-unknown";
    if (!reason && mainJob) {
      if (mainJob.conclusion === "success") verdict = "pr-only";
      else if (failed(mainJob.conclusion) && prStep && mainStep)
        verdict =
          prStep === mainStep
            ? "main-fails-same-step"
            : "main-fails-other-step";
      else
        reason = failed(mainJob.conclusion)
          ? "First failed step is missing on PR or main"
          : `Main job conclusion is ${mainJob.conclusion || "missing"}`;
    }
    const next =
      verdict === "pr-only"
        ? "Read the failed step's log and fix the cause; a retry needs a named flake issue."
        : verdict === "main-fails-same-step"
          ? "The failure is on main too; file or link the main issue, do not retry."
          : verdict === "main-fails-other-step"
            ? "Compare both logs before deciding."
            : `Missing comparison evidence: ${reason}.`;
    return {
      name: check.name,
      pr: {
        conclusion: check.conclusion!.toLowerCase(),
        failedStep: prStep,
        url: check.detailsUrl ?? null,
      },
      main: mainRun
        ? {
            runId: mainRun.databaseId,
            headSha: mainRun.headSha,
            conclusion: mainJob?.conclusion ?? null,
            failedStep: mainStep,
          }
        : null,
      verdict,
      ...(reason ? { reason } : {}),
      next,
    };
  });
  const headSha = head.headRefOid;
  return { repo, pr: Number(pr), headSha, mainHead, comparisons, cancelled };
}
try {
  console.log(redact(JSON.stringify(compare(process.argv[2] ?? ""))));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ error: redact(message) }));
  process.exitCode = 1;
}
