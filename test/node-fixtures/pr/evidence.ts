export const head = "a".repeat(40),
  oldHead = "b".repeat(40);
export const time = "2026-10-20T00:00:00Z",
  now = Date.parse(time) + 10000;
export const policy = {
  minApprovals: 1,
  settleMs: 0,
  optionalChecks: "safe-terminal" as const,
  allowNoChecks: false,
  blockingLabels: ["hold"],
  mergeMethod: "squash" as const,
};
export function ready() {
  return {
    ref: { repository: "owner/repo", number: 1 },
    observedAt: time,
    core: {
      headSha: head,
      baseSha: oldHead,
      baseBranch: "main",
      state: "OPEN",
      draft: false,
      mergeable: "MERGEABLE",
      updatedAt: time,
      host: {
        mergeStateStatus: "CLEAN",
        reviewDecision: "APPROVED",
        allowedMergeMethods: ["squash"],
        canBypass: false,
      },
    },
    checks: [
      {
        name: "test",
        appId: 1,
        headSha: head,
        status: "COMPLETED",
        conclusion: "SUCCESS",
        startedAt: time,
      },
    ],
    requiredChecks: [{ name: "test", appId: 1, strict: false }],
    reviews: [
      {
        id: "review",
        author: "alice",
        authorizing: true,
        state: "APPROVED",
        commitSha: head,
        submittedAt: time,
        createdAt: time,
        updatedAt: time,
      },
    ],
    threads: [],
    labels: [],
    requirements: [],
    gaps: [],
  };
}
