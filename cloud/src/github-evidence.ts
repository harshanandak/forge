import { withGithubHttp } from "./github-http.ts";
import { readGithubWorkflowEvidence } from "./github-workflow-evidence.ts";
import { isPlainJson } from "./plain-json.ts";
import type * as Evidence from "./merge-evidence.ts";
type Pr = Evidence.MergeObservations["initialPr"];
type Session = Parameters<Parameters<typeof withGithubHttp>[2]>[0];
const sha = /^[a-f0-9]{40}$/,
  digest = /^[a-f0-9]{64}$/;
const text = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= 256 &&
  v.trim() === v &&
  !/[\p{Cc}]/u.test(v);
const matches = (v: unknown, re: RegExp): v is string => text(v) && re.test(v);
const positive = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const stamp = (v: unknown, now: number): v is string =>
  matches(v, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/) &&
  new Date(v).toJSON() === (v.length === 20 ? v.replace("Z", ".000Z") : v) &&
  Date.parse(v) <= now;
// The callback keeps future workflow reads inside this session and PR readback.
export async function withGithubPrEvidence<T>(
  input: unknown,
  ports: Parameters<typeof withGithubHttp>[1],
  read: (session: Session, initialPr: Pr) => Promise<T>,
) {
  type Code = "INPUT_INVALID" | "UNAVAILABLE";
  const failure = { code: "UNAVAILABLE" as Code };
  const refuse = (c: Code) => ({
    ok: false as const,
    code: c,
    reason:
      c === "INPUT_INVALID" ? "Invalid GitHub evidence" : "GitHub unavailable",
  });
  function fail(c: Code = "INPUT_INVALID"): never {
    failure.code = c;
    throw new Error("GitHub evidence refused");
  }
  function object(v: unknown): Record<string, unknown> {
    if (!v || typeof v !== "object" || Array.isArray(v)) fail();
    return v as Record<string, unknown>;
  }
  function fields(v: unknown, names: string) {
    const o = object(v),
      keys = names.split(" ");
    if (
      Object.keys(o).length !== keys.length ||
      keys.some((k) => !Object.hasOwn(o, k))
    )
      fail();
    return o;
  }
  try {
    if (!isPlainJson(input)) fail();
    const root = fields(structuredClone(input), "locator policy binding");
    const l = object(root.locator),
      p = fields(
        root.policy,
        "project repositoryId baseBranch version digest producer requiredChecks",
      ),
      b = fields(
        root.binding,
        "project issueId linkKey linkRevision repositoryId prNumber prId headSha",
      );
    const producer = fields(
      p.producer,
      "repositoryId appId workflowId workflowPath workflowDigest",
    );
    const now = ports.now();
    if (
      !Number.isFinite(now) ||
      now < 0 ||
      !matches(p.project, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/) ||
      !positive(p.repositoryId) ||
      !text(p.baseBranch) ||
      !text(p.version) ||
      !matches(p.digest, digest) ||
      ![producer.appId, producer.workflowId].every(positive) ||
      !matches(
        producer.workflowPath,
        /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/,
      ) ||
      !matches(producer.workflowDigest, digest) ||
      !Array.isArray(p.requiredChecks) ||
      !p.requiredChecks.length ||
      !p.requiredChecks.every(text) ||
      new Set(p.requiredChecks).size !== p.requiredChecks.length ||
      !matches(b.issueId, /^work-\d+$/) ||
      !text(b.linkKey) ||
      !new RegExp(`^link:${b.issueId}:\\d+$`).test(b.linkKey) ||
      ![b.linkRevision, b.prNumber].every(positive) ||
      !text(b.prId) ||
      !matches(b.headSha, sha) ||
      p.project !== b.project ||
      p.repositoryId !== b.repositoryId ||
      producer.repositoryId !== p.repositoryId ||
      l.repositoryId !== b.repositoryId ||
      l.prNumber !== b.prNumber ||
      l.branch !== p.baseBranch
    )
      fail();
    const policy = p as Evidence.MergePolicy,
      binding = b as Evidence.DeliveryBinding;
    function pr(value: unknown): Pr {
      const v = object(value),
        base = object(v.base),
        repo = object(base.repo),
        head = object(v.head);
      if (
        repo.id !== binding.repositoryId ||
        v.number !== binding.prNumber ||
        v.node_id !== binding.prId ||
        head.sha !== binding.headSha ||
        base.ref !== policy.baseBranch ||
        !matches(v.state, /^(open|closed)$/) ||
        typeof v.merged !== "boolean" ||
        (v.merged && v.state !== "closed") ||
        (v.merged
          ? !matches(v.merge_commit_sha, sha) || !stamp(v.merged_at, now)
          : v.merged_at !== null) ||
        (v.merge_commit_sha !== null && !matches(v.merge_commit_sha, sha))
      )
        fail();
      return {
        repositoryId: binding.repositoryId,
        number: binding.prNumber,
        id: binding.prId,
        headSha: head.sha,
        state: v.merged ? "MERGED" : v.state === "open" ? "OPEN" : "CLOSED",
        mergeSha: v.merged ? v.merge_commit_sha : null,
        mergedAt: v.merged ? (v.merged_at as string) : null,
        baseBranch: base.ref,
      };
    }
    const result = await withGithubHttp(l, ports, async (session) => {
      const path = ["pulls", String(binding.prNumber)],
        initialPr = pr(await session.get(path));
      if (initialPr.mergeSha === null) fail("UNAVAILABLE");
      const branch = object(
          await session.get(["git", "ref", "heads", policy.baseBranch]),
        ),
        target = object(branch.object);
      if (
        branch.ref !== `refs/heads/${policy.baseBranch}` ||
        target.type !== "commit" ||
        !matches(target.sha, sha)
      )
        fail();
      const targetTip = target.sha,
        mergeSha = initialPr.mergeSha;
      const comparison = object(
        await session.get(["compare", `${mergeSha}...${targetTip}`]),
      );
      const base = object(comparison.base_commit),
        common = object(comparison.merge_base_commit);
      const ahead = comparison.ahead_by,
        behind = comparison.behind_by;
      if (
        base.sha !== mergeSha ||
        !matches(common.sha, sha) ||
        !(ahead === 0 || positive(ahead)) ||
        !(behind === 0 || positive(behind))
      )
        fail();
      if (!matches(comparison.status, /^(ahead|behind|identical|diverged)$/))
        fail("UNAVAILABLE");
      const ancestor = common.sha === mergeSha;
      if (
        comparison.status === "identical"
          ? targetTip !== mergeSha || !ancestor || ahead !== 0 || behind !== 0
          : targetTip === mergeSha ||
            (comparison.status === "ahead"
              ? !ancestor || ahead === 0 || behind !== 0
              : comparison.status === "behind"
                ? common.sha !== targetTip || ahead !== 0 || behind === 0
                : ancestor ||
                  common.sha === targetTip ||
                  ahead === 0 ||
                  behind === 0)
      )
        fail();
      const evidence = await read(session, Object.freeze({ ...initialPr }));
      const finalPr = pr(await session.get(path));
      if (JSON.stringify(initialPr) !== JSON.stringify(finalPr)) fail();
      return {
        binding: { ...binding },
        initialPr,
        finalPr,
        targetTip,
        ancestry: ancestor ? ("ancestor" as const) : ("not-ancestor" as const),
        evidence,
      };
    });
    return result.ok
      ? result
      : refuse(failure.code === "INPUT_INVALID" ? failure.code : result.code);
  } catch {
    return refuse(failure.code);
  }
}

export async function readGithubMergeEvidence(
  input: unknown,
  ports: Parameters<typeof withGithubHttp>[1],
) {
  type Code = "INPUT_INVALID" | "UNAVAILABLE";
  const failure: { code: Code } = { code: "UNAVAILABLE" };
  const refuse = (code: Code) => ({
    ok: false as const,
    code,
    reason:
      code === "INPUT_INVALID"
        ? "Invalid GitHub evidence"
        : "GitHub unavailable",
  });
  function fail(code: Code = "INPUT_INVALID"): never {
    failure.code = code;
    throw new Error("GitHub evidence refused");
  }
  function object(v: unknown) {
    if (!v || typeof v !== "object" || Array.isArray(v)) fail();
    return v as Record<string, unknown>;
  }
  function budget(value: unknown) {
    if (new TextEncoder().encode(JSON.stringify(value)).length > 128 * 1024)
      fail();
  }
  try {
    if (!isPlainJson(input)) fail();
    const snapshot: unknown = structuredClone(input);
    budget(snapshot);
    const locator = object(object(snapshot).locator);
    const checkRoot = `https://api.github.com/repos/${encodeURIComponent(String(locator.owner))}/${encodeURIComponent(String(locator.repo))}/check-runs/`;
    const seen = new Set<number>();
    const result = await withGithubPrEvidence(
      snapshot,
      ports,
      async (session, pr) => {
        const workflow = await readGithubWorkflowEvidence(session, pr);
        if (!workflow.ok) return workflow;
        const runs: Evidence.MergeObservations["runs"][number][] = [];
        for (const { checkSuiteId, ...run } of workflow.value) {
          const jobs = await session.collect(
            [
              "actions",
              "runs",
              String(run.id),
              "attempts",
              String(run.attempt),
              "jobs",
            ],
            {},
            "jobs",
          );
          const checks: Evidence.MergeObservations["runs"][number]["checks"][number][] =
            [];
          for (const raw of jobs) {
            const job = object(raw);
            if (
              job.run_id !== run.id ||
              job.run_attempt !== run.attempt ||
              job.head_sha !== run.headSha
            )
              fail();
            if (
              typeof job.check_run_url !== "string" ||
              !job.check_run_url.startsWith(checkRoot)
            )
              fail("UNAVAILABLE");
            const suffix = job.check_run_url.slice(checkRoot.length),
              id = Number(suffix);
            if (!positive(id) || String(id) !== suffix) fail("UNAVAILABLE");
            if (seen.has(id)) fail();
            seen.add(id);
            const check = object(await session.get(["check-runs", suffix]));
            if (
              check.id !== id ||
              object(check.check_suite).id !== checkSuiteId ||
              object(check.app).id !== run.appId ||
              check.head_sha !== run.headSha ||
              !text(check.name) ||
              ["name", "status", "conclusion", "completed_at"].some(
                (key) => job[key] !== check[key],
              ) ||
              !matches(check.status, /^(queued|in_progress|completed)$/) ||
              (check.conclusion !== null &&
                !matches(
                  check.conclusion,
                  /^(success|failure|neutral|cancelled|skipped|timed_out|action_required|stale|startup_failure)$/,
                )) ||
              (check.status === "completed"
                ? check.conclusion === null ||
                  !stamp(check.completed_at, ports.now())
                : check.conclusion !== null || check.completed_at !== null)
            )
              fail();
            checks.push({
              id,
              appId: run.appId,
              attempt: run.attempt,
              name: check.name,
              headSha: run.headSha,
              status: check.status,
              conclusion: check.conclusion,
              completedAt: check.completed_at,
            } as Evidence.MergeObservations["runs"][number]["checks"][number]);
          }
          runs.push({ ...run, checks });
          budget([snapshot, runs]);
        }
        return { ok: true as const, value: runs };
      },
    );
    if (!result.ok)
      return refuse(
        failure.code === "INPUT_INVALID" ? failure.code : result.code,
      );
    const { evidence, ...facts } = result.value;
    if (!evidence.ok) return evidence;
    const observation: Evidence.MergeObservations = {
      ...facts,
      runs: evidence.value,
      completeness: "complete",
    };
    budget([snapshot, observation, new Date(ports.now()).toJSON()]);
    return { ok: true as const, value: observation };
  } catch {
    return refuse(failure.code);
  }
}
