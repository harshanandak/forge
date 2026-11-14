import type { withGithubPrEvidence } from "./github-evidence.ts";
import type { MergeObservations } from "./merge-evidence.ts";

export type WorkflowAttempt = Omit<
  MergeObservations["runs"][number],
  "checks"
> & {
  readonly checkSuiteId: number;
};
// Called inside withGithubPrEvidence's callback; later job/check reads share it.
export async function readGithubWorkflowEvidence(
  session: Parameters<Parameters<typeof withGithubPrEvidence>[2]>[0],
  pr: Pick<MergeObservations["initialPr"], "repositoryId" | "mergeSha">,
) {
  type Code = "INPUT_INVALID" | "UNAVAILABLE";
  const failure: { code: Code } = { code: "UNAVAILABLE" };
  function fail(c: Code = "INPUT_INVALID"): never {
    failure.code = c;
    throw new Error("GitHub evidence refused");
  }
  function object(v: unknown, c: Code = "INPUT_INVALID") {
    if (!v || typeof v !== "object" || Array.isArray(v)) fail(c);
    return v as Record<string, unknown>;
  }
  const positive = (v: unknown): v is number =>
    typeof v === "number" && Number.isSafeInteger(v) && v > 0;
  function run(value: unknown) {
    const v = object(value);
    if (v.check_suite_id == null) fail("UNAVAILABLE");
    if (
      ![v.id, v.run_number, v.run_attempt, v.workflow_id].every(positive) ||
      !positive(v.check_suite_id) ||
      object(v.repository).id !== pr.repositoryId ||
      v.head_sha !== pr.mergeSha ||
      typeof v.path !== "string" ||
      !/^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/.test(v.path) ||
      v.path.length > 256 ||
      [v.path, v.status, v.conclusion].some(
        (s) => typeof s === "string" && s.trim() !== s,
      ) ||
      typeof v.status !== "string" ||
      !/^(queued|in_progress|completed)$/.test(v.status) ||
      (v.conclusion !== null &&
        (typeof v.conclusion !== "string" ||
          !/^(success|failure|neutral|cancelled|skipped|timed_out|action_required|stale|startup_failure)$/.test(
            v.conclusion,
          ))) ||
      (v.status === "completed") !== (v.conclusion !== null)
    )
      fail();
    return {
      repositoryId: pr.repositoryId,
      id: v.id,
      runNumber: v.run_number,
      attempt: v.run_attempt,
      workflowId: v.workflow_id,
      workflowPath: v.path,
      headSha: v.head_sha,
      status: v.status,
      conclusion: v.conclusion,
      checkSuiteId: v.check_suite_id,
    } as Omit<WorkflowAttempt, "appId" | "workflowDigest">;
  }
  try {
    if (pr.mergeSha === null) fail("UNAVAILABLE");
    if (
      !positive(pr.repositoryId) ||
      pr.mergeSha.length !== 40 ||
      !/^[a-f0-9]{40}$/.test(pr.mergeSha)
    )
      fail();
    const rows = await session.collect(
      ["actions", "runs"],
      { head_sha: pr.mergeSha },
      "workflow_runs",
    );
    const runs: WorkflowAttempt[] = [];
    for (const row of rows) {
      const latest = run(row);
      const content = object(
        await session.get(["contents", ...latest.workflowPath.split("/")], {
          ref: pr.mergeSha,
        }),
        "UNAVAILABLE",
      );
      if (
        content.type !== "file" ||
        content.path !== latest.workflowPath ||
        content.encoding !== "base64" ||
        typeof content.content !== "string" ||
        typeof content.size !== "number" ||
        !Number.isSafeInteger(content.size) ||
        content.size < 0
      )
        fail("UNAVAILABLE");
      const encoded = content.content.replace(/\n/g, "");
      let decoded: string;
      try {
        decoded = atob(encoded);
      } catch {
        fail("UNAVAILABLE");
      }
      if (btoa(decoded) !== encoded || decoded.length !== content.size)
        fail("UNAVAILABLE");
      const bytes = Uint8Array.from(decoded, (v) => v.charCodeAt(0));
      const workflowDigest = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (v) => v.toString(16).padStart(2, "0"),
      ).join("");
      for (let attempt = 1; attempt <= latest.attempt; attempt++) {
        const current = run(
          await session.get([
            "actions",
            "runs",
            String(latest.id),
            "attempts",
            String(attempt),
          ]),
        );
        if (
          current.attempt !== attempt ||
          (
            [
              "id",
              "runNumber",
              "workflowId",
              "workflowPath",
              "headSha",
              "repositoryId",
            ] as const
          ).some((k) => current[k] !== latest[k]) ||
          (attempt === latest.attempt &&
            (["checkSuiteId", "status", "conclusion"] as const).some(
              (k) => current[k] !== latest[k],
            ))
        )
          fail();
        const suite = object(
          await session.get(["check-suites", String(current.checkSuiteId)]),
          "UNAVAILABLE",
        );
        const appId = object(suite.app, "UNAVAILABLE").id;
        if (
          suite.id !== current.checkSuiteId ||
          suite.head_sha !== pr.mergeSha ||
          object(suite.repository).id !== pr.repositoryId ||
          !positive(appId)
        )
          fail();
        runs.push({ ...current, appId, workflowDigest });
      }
    }
    return { ok: true as const, value: runs };
  } catch {
    return {
      ok: false as const,
      code: failure.code,
      reason:
        failure.code === "INPUT_INVALID"
          ? "Invalid GitHub evidence"
          : "GitHub unavailable",
    };
  }
}
