export const head = "a".repeat(40),
  merge = "b".repeat(40),
  tip = "c".repeat(40);
export const at = "2026-11-13T10:00:00.000Z",
  now = "2026-11-13T11:00:00.000Z";
export function fixture() {
  const producer = {
    repositoryId: 42,
    appId: 15368,
    workflowId: 99,
    workflowPath: ".github/workflows/ci.yml",
    workflowDigest: "d".repeat(64),
  };
  const binding = {
    project: "forge",
    issueId: "work-1248",
    linkKey: "link:work-1248:1",
    linkRevision: 1,
    repositoryId: 42,
    prNumber: 490,
    prId: "PR_example",
    headSha: head,
  };
  const check = {
    id: 301,
    appId: producer.appId,
    attempt: 1,
    name: "CI Gate",
    headSha: merge,
    status: "completed",
    conclusion: "success",
    completedAt: at as string | null,
  };
  const run = {
    ...producer,
    id: 201,
    runNumber: 10,
    attempt: 1,
    headSha: merge,
    status: "completed",
    conclusion: "success",
    checks: [check],
  };
  const pr = {
    repositoryId: 42,
    number: 490,
    id: "PR_example",
    headSha: head,
    state: "MERGED",
    mergeSha: merge as string | null,
    mergedAt: at as string | null,
    baseBranch: "main",
  };
  return {
    policy: {
      project: "forge",
      repositoryId: 42,
      baseBranch: "main",
      version: "1",
      digest: "e".repeat(64),
      producer,
      requiredChecks: ["CI Gate"],
    },
    expected: binding,
    observation: {
      binding: { ...binding },
      initialPr: { ...pr },
      finalPr: { ...pr },
      targetTip: tip,
      ancestry: "ancestor",
      completeness: "complete",
      runs: [run],
    },
  };
}
