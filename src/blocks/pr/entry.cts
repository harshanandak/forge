import type { HandlerArgs } from "../../contract/author.ts";
import type { ProcessPort } from "../../ports/process.ts";
import type { BlockerCode } from "./contract.ts";
type Input = { repo: string; number: number; expectHead?: string };
type Services = {
  process: ProcessPort;
  files: { root: string };
  environment: {
    select(names: readonly string[]): Readonly<Record<string, string>>;
  };
};
type Call = HandlerArgs<Input, { requireResolvedThreads?: boolean }, Services>;
const reason = (code: BlockerCode, message: string) => ({ code, message });
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid GitHub response");
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Invalid GitHub list");
  return value;
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : "GitHub command failed";
}
function client(call: Pick<Call, "services" | "signal" | "deadline">) {
  const env = call.services.environment.select(
    "PATH PATHEXT SystemRoot HOME USERPROFILE GH_TOKEN GITHUB_TOKEN GH_CONFIG_DIR APPDATA XDG_CONFIG_HOME DBUS_SESSION_BUS_ADDRESS HTTPS_PROXY HTTP_PROXY NO_PROXY https_proxy http_proxy no_proxy".split(
      " ",
    ),
  );
  const executable = call.services.process.resolve("gh", env);
  return async (
    args: string[],
    json = true,
    maxOutputBytes = 1048576,
  ): Promise<unknown> => {
    if (executable.kind !== "resolved")
      throw new Error("UNAVAILABLE: gh is not installed");
    const result = await call.services.process.run(executable, args, {
      cwd: call.services.files.root,
      env,
      signal: call.signal,
      timeoutMs: Math.max(1, call.deadline - Date.now()),
      maxOutputBytes,
    });
    if (
      result.exitCode !== 0 ||
      result.timedOut ||
      result.truncated ||
      result.signal
    )
      throw new Error(result.stderr || "GitHub command did not complete");
    return json ? (JSON.parse(result.stdout) as unknown) : result.stdout;
  };
}
const ref = (input: Input) => [String(input.number), "--repo", input.repo];
const view = (input: Input, fields: string) => [
  "pr",
  "view",
  ...ref(input),
  "--json",
  fields,
];
async function status(call: Call) {
  let head: string | null = null,
    state = "UNKNOWN",
    verdict = "BLOCKED";
  const reasons: ReturnType<typeof reason>[] = [];
  const add = (code: BlockerCode, text: string) =>
    reasons.push(reason(code, text));
  if (!/^[\w.-]+\/[\w.-]+$/.test(call.input.repo))
    return {
      head,
      state,
      verdict: "UNAVAILABLE",
      reasons: [
        reason(
          "HOST_BLOCKED",
          "Only GitHub owner/repository references are supported",
        ),
      ],
    };
  try {
    const gh = client(call);
    const pr = object(
      await gh(
        view(
          call.input,
          "number,state,isDraft,headRefOid,baseRefName,mergeStateStatus,reviewDecision,statusCheckRollup",
        ),
      ),
    );
    if (
      typeof pr.headRefOid !== "string" ||
      typeof pr.state !== "string" ||
      typeof pr.isDraft !== "boolean" ||
      typeof pr.mergeStateStatus !== "string"
    )
      throw new Error("Invalid GitHub PR response");
    head = pr.headRefOid;
    state = pr.state;
    const [owner, name] = call.input.repo.split("/");
    const query =
      "query($owner:String!,$name:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){isMergeQueueEnabled reviewThreads(first:100,after:$endCursor){nodes{isResolved} pageInfo{hasNextPage endCursor}}}}}";
    const pages = array(
      await gh([
        "api",
        "graphql",
        "--paginate",
        "--slurp",
        "-f",
        `query=${query}`,
        "-f",
        `owner=${owner}`,
        "-f",
        `name=${name}`,
        "-F",
        `number=${call.input.number}`,
      ]),
    );
    if (!pages.length) throw new Error("Missing review threads");
    let unresolved = 0,
      mergeQueue = false;
    for (const page of pages) {
      const data = object(page);
      if (data.errors) throw new Error("GitHub could not read review threads");
      const pull = object(object(object(data.data).repository).pullRequest);
      if (typeof pull.isMergeQueueEnabled !== "boolean")
        throw new Error("Missing merge queue status");
      mergeQueue ||= pull.isMergeQueueEnabled;
      const threads = object(pull.reviewThreads);
      for (const node of array(threads.nodes)) {
        const thread = object(node);
        if (typeof thread.isResolved !== "boolean")
          throw new Error("Invalid review thread");
        if (!thread.isResolved) unresolved++;
      }
    }
    if (call.config.requireResolvedThreads !== false && unresolved)
      add("REQUIREMENT_UNSATISFIED", `${unresolved} unresolved review threads`);
    const review = pr.reviewDecision;
    if (review === "CHANGES_REQUESTED" || review === "REVIEW_REQUIRED")
      add(
        review === "CHANGES_REQUESTED" ? "REVIEW_BLOCKED" : "REVIEW_REQUIRED",
        review,
      );
    if (state === "MERGED" || state === "CLOSED") verdict = state;
    else if (mergeQueue) {
      verdict = "UNSUPPORTED";
      add("MERGE_METHOD_UNAVAILABLE", "The base branch requires a merge queue");
    } else if (pr.isDraft) verdict = "DRAFT";
    else if (pr.mergeStateStatus === "BEHIND") verdict = "BEHIND";
    else if (
      state === "OPEN" &&
      pr.mergeStateStatus === "CLEAN" &&
      !reasons.length
    )
      verdict = "READY";
    for (const item of array(pr.statusCheckRollup ?? [])) {
      const check = object(item),
        result = String(check.conclusion || check.state || check.status);
      if (!["SUCCESS", "NEUTRAL", "SKIPPED"].includes(result))
        add(
          "FAILURE ERROR CANCELLED TIMED_OUT ACTION_REQUIRED STALE STARTUP_FAILURE"
            .split(" ")
            .includes(result)
            ? "CHECK_FAILED"
            : "CHECK_PENDING",
          String(check.name || check.context) + ": " + result,
        );
    }
    if (verdict === "DRAFT") add("DRAFT", "GitHub reports a draft");
    if (pr.mergeStateStatus !== "CLEAN")
      add("HOST_BLOCKED", pr.mergeStateStatus);
  } catch (error) {
    const text = message(error);
    if (text.startsWith("UNAVAILABLE:")) verdict = "UNAVAILABLE";
    add("HOST_BLOCKED", text);
  }
  return { head, state, verdict, reasons };
}
async function merge(call: Call) {
  const before = await status(call);
  const blocked = (text: string) => ({
    ...before,
    merged: false,
    verdict: "BLOCKED",
    reasons: [reason("HOST_BLOCKED", text)],
  });
  if (before.verdict !== "READY") return { ...before, merged: false };
  if (before.head !== call.input.expectHead)
    return blocked("Head does not match expectHead");
  const gh = client(call);
  try {
    await gh(
      [
        "pr",
        "merge",
        ...ref(call.input),
        "--squash",
        "--match-head-commit",
        call.input.expectHead,
      ],
      false,
    );
  } catch (error) {
    return blocked(message(error));
  }
  try {
    const after = object(await gh(view(call.input, "state,mergeCommit")));
    const commit = object(after.mergeCommit);
    if (after.state !== "MERGED" || typeof commit.oid !== "string")
      throw new Error("GitHub has not confirmed a merge commit");
    return { merged: true, mergeCommit: commit.oid };
  } catch (error) {
    return {
      ...before,
      merged: false,
      verdict: "UNAVAILABLE",
      reasons: [
        reason(
          "EVIDENCE_GAP",
          "Merge command succeeded but could not be confirmed: " +
            message(error),
        ),
      ],
    };
  }
}
type CiCall = HandlerArgs<
  Pick<Input, "repo" | "number">,
  { ciExcerptLines?: number },
  Services
>;
type Gh = ReturnType<typeof client>;
type Failed = { name: string; url: string | null; runId: string | null };
const FAILED = "FAILURE ERROR TIMED_OUT STARTUP_FAILURE".split(" ");
const LOG_BYTES = 8388608;
const ciReason = (code: BlockerCode, text: string) => [reason(code, text)];
const unavailable = (text: string) => ({
  verdict:
    text.startsWith("UNAVAILABLE:") || text.startsWith("Only GitHub")
      ? "UNAVAILABLE"
      : "BLOCKED",
  reasons: ciReason("HOST_BLOCKED", text),
});
const githubRepo = (repo: string) => /^[\w.-]+\/[\w.-]+$/.test(repo);
async function failedChecks(gh: Gh, call: CiCall) {
  const pr = object(
    await gh(view(call.input, "statusCheckRollup,baseRefName")),
  );
  const failed: Failed[] = [];
  for (const item of array(pr.statusCheckRollup ?? [])) {
    const check = object(item),
      result = String(check.conclusion || check.state);
    if (!FAILED.includes(result)) continue;
    const link = check.detailsUrl || check.targetUrl,
      url = typeof link === "string" && link ? link : null;
    failed.push({
      name: String(check.name || check.context),
      url,
      runId: url?.match(/\/actions\/runs\/(\d+)/)?.[1] ?? null,
    });
  }
  return { failed, base: String(pr.baseRefName) };
}
/** Lines of this job's log (its prefix stripped) around the first error, never more than `max`. */
function excerpt(log: string, job: string, max: number): string {
  const all = log.split("\n").filter(Boolean);
  const own = all.filter((line) => line.split("\t")[0] === job);
  const lines = (own.length ? own : all).map((line) => {
    const parts = line.split("\t");
    return (parts.length > 2 ? parts.slice(2).join("\t") : line).slice(0, 400);
  });
  const first = lines.findIndex((line) =>
    /\b(error|failed|failure|exception|panic|fatal)\b/i.test(line),
  );
  const start = first < 0 ? Math.max(0, lines.length - max) : first;
  return lines.slice(start, start + max).join("\n");
}
async function ciFailures(call: CiCall) {
  if (!githubRepo(call.input.repo))
    return {
      ...unavailable("Only GitHub owner/repository references are supported"),
      failures: [],
    };
  const reasons: ReturnType<typeof reason>[] = [];
  const max = Math.min(Math.max(call.config.ciExcerptLines ?? 40, 1), 200);
  try {
    const gh = client(call);
    const { failed, base } = await failedChecks(gh, call);
    let red: Set<string> | null = null;
    if (failed.length)
      try {
        const pages = array(
          await gh([
            "api",
            "--paginate",
            "--slurp",
            `repos/${call.input.repo}/commits/${encodeURIComponent(base)}/check-runs`,
          ]),
        );
        red = new Set(
          pages.flatMap((page) =>
            array(object(page).check_runs)
              .map(object)
              .filter((run) =>
                FAILED.includes(String(run.conclusion).toUpperCase()),
              )
              .map((run) => String(run.name)),
          ),
        );
      } catch (error) {
        reasons.push(
          reason("EVIDENCE_GAP", "Base checks unreadable: " + message(error)),
        );
      }
    const logs = new Map<string, string | null>();
    const failures = [];
    for (const check of failed) {
      let text: string | null = null;
      if (check.runId) {
        if (!logs.has(check.runId))
          try {
            logs.set(
              check.runId,
              String(
                await gh(
                  [
                    "run",
                    "view",
                    check.runId,
                    "--repo",
                    call.input.repo,
                    "--log-failed",
                  ],
                  false,
                  LOG_BYTES,
                ),
              ),
            );
          } catch (error) {
            logs.set(check.runId, null);
            reasons.push(
              reason(
                "EVIDENCE_GAP",
                `Log of run ${check.runId} unreadable: ` + message(error),
              ),
            );
          }
        const log = logs.get(check.runId);
        if (log) text = excerpt(log, check.name, max);
      }
      failures.push({
        ...check,
        excerpt: text,
        alsoRedOnBase: red ? red.has(check.name) : null,
      });
    }
    return {
      verdict: failures.length ? "FAILING" : "NO_FAILURES",
      failures,
      reasons,
    };
  } catch (error) {
    const text = message(error);
    return { ...unavailable(text), failures: [] };
  }
}
async function ciRerun(call: CiCall) {
  if (!githubRepo(call.input.repo))
    return {
      ...unavailable("Only GitHub owner/repository references are supported"),
      runs: [],
    };
  const reasons: ReturnType<typeof reason>[] = [];
  const runs: { runId: string; rerun: boolean; attempt: number | null }[] = [];
  try {
    const gh = client(call);
    const { failed } = await failedChecks(gh, call);
    const ids = [...new Set(failed.flatMap((check) => check.runId ?? []))];
    for (const runId of ids) {
      const target = ["--repo", call.input.repo];
      try {
        await gh(["run", "rerun", runId, "--failed", ...target], false);
      } catch (error) {
        runs.push({ runId, rerun: false, attempt: null });
        reasons.push(reason("HOST_BLOCKED", `Run ${runId}: ` + message(error)));
        continue;
      }
      let attempt: number | null = null;
      try {
        const run = object(
          await gh(["run", "view", runId, ...target, "--json", "attempt"]),
        );
        if (typeof run.attempt !== "number") throw new Error("Missing attempt");
        attempt = run.attempt;
      } catch (error) {
        reasons.push(
          reason(
            "EVIDENCE_GAP",
            `Run ${runId} attempt unreadable: ` + message(error),
          ),
        );
      }
      runs.push({ runId, rerun: true, attempt });
    }
    return {
      verdict: !ids.length
        ? "NOTHING_TO_RERUN"
        : runs.some((run) => run.rerun)
          ? "RERUN"
          : "BLOCKED",
      runs,
      reasons,
    };
  } catch (error) {
    return { ...unavailable(message(error)), runs: [] };
  }
}
module.exports = {
  "pr.status": status,
  "pr.merge": merge,
  "pr.ci-failures": ciFailures,
  "pr.ci-rerun": ciRerun,
};
