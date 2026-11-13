import { expect, test } from "bun:test";
import { evaluateMergeEvidence } from "../../cloud/src/merge-evidence.ts";
import { exitCode, failure } from "../../src/surface/result.ts";

const head = "a".repeat(40),
  merge = "b".repeat(40),
  tip = "c".repeat(40);
const at = "2026-11-13T10:00:00.000Z",
  now = "2026-11-13T11:00:00.000Z";
function fixture() {
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
    completedAt: at as string | null,
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
type Fixture = ReturnType<typeof fixture>;
type Row = readonly [string, (f: Fixture) => void, string | null];
const rows: Row[] = [
  [
    "valid merge",
    (f) => {
      f.expected.headSha = merge;
      f.observation.binding.headSha = merge;
      f.observation.initialPr.headSha = merge;
      f.observation.finalPr.headSha = merge;
    },
    null,
  ],
  ["squash or rebase keeps final head separately", () => {}, null],
  ...["OPEN", "CLOSED"].map((state): Row => [
    state,
    (f) => {
      for (const pr of [f.observation.initialPr, f.observation.finalPr])
        Object.assign(pr, { state, mergeSha: null, mergedAt: null });
    },
    "PR_NOT_MERGED",
  ]),
  ...["repositoryId", "prNumber", "linkRevision"].map((field): Row => [
    `binding ${field}`,
    (f) => Object.assign(f.observation.binding, { [field]: 500 }),
    "INPUT_CONFLICT",
  ]),
  ...["project", "issueId", "linkKey", "prId", "headSha"].map((field): Row => [
    `binding ${field}`,
    (f) => {
      Object.assign(f.observation.binding, {
        [field]: (
          {
            project: "other",
            issueId: "work-2",
            linkKey: "link:work-1248:2",
            prId: "PR_other",
            headSha: tip,
          } as Record<string, string>
        )[field],
      });
      if (field === "issueId") f.observation.binding.linkKey = "link:work-2:1";
    },
    "INPUT_CONFLICT",
  ]),
  [
    "wrong observed repository",
    (f) => {
      f.observation.finalPr.repositoryId++;
    },
    "INPUT_CONFLICT",
  ],
  [
    "wrong observed PR",
    (f) => {
      f.observation.finalPr.number++;
    },
    "INPUT_CONFLICT",
  ],
  [
    "wrong observed PR node",
    (f) => {
      f.observation.finalPr.id = "PR_other";
    },
    "INPUT_CONFLICT",
  ],
  [
    "wrong policy project",
    (f) => {
      f.policy.project = "other";
    },
    "INPUT_CONFLICT",
  ],
  [
    "wrong policy repository",
    (f) => {
      f.policy.repositoryId++;
    },
    "INPUT_CONFLICT",
  ],
  [
    "wrong base",
    (f) => {
      f.observation.finalPr.baseBranch = "dev";
    },
    "PR_NOT_MERGED",
  ],
  [
    "merge absent from target",
    (f) => {
      f.observation.ancestry = "not-ancestor";
    },
    "PR_NOT_MERGED",
  ],
  [
    "final head changed",
    (f) => {
      f.observation.finalPr.headSha = tip;
    },
    "INPUT_CONFLICT",
  ],
  [
    "initial head changed",
    (f) => {
      f.observation.initialPr.headSha = tip;
    },
    "INPUT_CONFLICT",
  ],
  [
    "merge changed during reads",
    (f) => {
      f.observation.initialPr.mergeSha = tip;
    },
    "INPUT_CONFLICT",
  ],
  ...[head, tip].map((sha): Row => [
    "wrong workflow subject",
    (f) => {
      f.observation.runs[0]!.headSha = sha;
    },
    "RECEIPT_HEAD_MISMATCH",
  ]),
  [
    "wrong check subject",
    (f) => {
      f.observation.runs[0]!.checks[0]!.headSha = head;
    },
    "RECEIPT_HEAD_MISMATCH",
  ],
  ...["repositoryId", "appId", "workflowId"].map((field): Row => [
    `wrong producer ${field}`,
    (f) => Object.assign(f.observation.runs[0]!, { [field]: 123 }),
    "RECEIPT_INVALID",
  ]),
  ...["workflowPath", "workflowDigest"].map((field): Row => [
    `wrong producer ${field}`,
    (f) =>
      Object.assign(f.observation.runs[0]!, {
        [field]:
          field === "workflowPath"
            ? ".github/workflows/other.yml"
            : "f".repeat(64),
      }),
    "RECEIPT_INVALID",
  ]),
  [
    "empty evidence",
    (f) => {
      f.observation.runs = [];
    },
    "RECEIPT_INVALID",
  ],
  [
    "wrong check App",
    (f) => {
      f.observation.runs[0]!.checks[0]!.appId++;
    },
    "RECEIPT_INVALID",
  ],
  [
    "missing required check",
    (f) => {
      f.observation.runs[0]!.checks = [];
    },
    "RECEIPT_INVALID",
  ],
  ...[
    "skipped",
    "neutral",
    "cancelled",
    "failure",
    "timed_out",
    "action_required",
    "stale",
  ].map((conclusion): Row => [
    `required ${conclusion}`,
    (f) => {
      f.observation.runs[0]!.checks[0]!.conclusion = conclusion;
    },
    "RECEIPT_INVALID",
  ]),
  [
    "newer failed attempt",
    (f) => {
      const newer = structuredClone(f.observation.runs[0]!);
      Object.assign(newer, { attempt: 2, conclusion: "failure" });
      f.observation.runs.push(newer);
    },
    "RECEIPT_INVALID",
  ],
  [
    "newer cancelled run",
    (f) => {
      const newer = structuredClone(f.observation.runs[0]!);
      Object.assign(newer, { id: 202, runNumber: 11, conclusion: "cancelled" });
      f.observation.runs.unshift(newer);
    },
    "RECEIPT_INVALID",
  ],
  [
    "newer run missing required check",
    (f) => {
      const newer = structuredClone(f.observation.runs[0]!);
      Object.assign(newer, { id: 202, runNumber: 11, checks: [] });
      f.observation.runs.push(newer);
    },
    "RECEIPT_INVALID",
  ],
  [
    "newer check failure",
    (f) => {
      const checks = f.observation.runs[0]!.checks;
      checks.push({
        ...checks[0]!,
        id: 302,
        attempt: 2,
        conclusion: "failure",
      });
    },
    "RECEIPT_INVALID",
  ],
  ...["queued", "in_progress"].map((status): Row => [
    `pending workflow ${status}`,
    (f) =>
      Object.assign(f.observation.runs[0]!, {
        status,
        conclusion: null,
        completedAt: null,
      }),
    "UNAVAILABLE",
  ]),
  [
    "pending required check",
    (f) =>
      Object.assign(f.observation.runs[0]!.checks[0]!, {
        status: "in_progress",
        conclusion: null,
        completedAt: null,
      }),
    "UNAVAILABLE",
  ],
  ...["outage", "permission", "truncated", "page-cap"].map(
    (completeness): Row => [
      completeness,
      (f) => {
        f.observation.completeness = completeness;
      },
      "UNAVAILABLE",
    ],
  ),
  [
    "unknown ancestry",
    (f) => {
      f.observation.ancestry = "unknown";
    },
    "UNAVAILABLE",
  ],
  [
    "empty policy checks",
    (f) => {
      f.policy.requiredChecks = [];
    },
    "UNAVAILABLE",
  ],
  [
    "duplicate policy checks",
    (f) => {
      f.policy.requiredChecks.push("CI Gate");
    },
    "UNAVAILABLE",
  ],
  [
    "invalid approved producer",
    (f) => {
      f.policy.producer.appId = 0;
    },
    "UNAVAILABLE",
  ],
  [
    "producer outside policy repository",
    (f) => {
      f.policy.producer.repositoryId++;
    },
    "UNAVAILABLE",
  ],
  [
    "missing policy digest",
    (f) => {
      f.policy.digest = "";
    },
    "UNAVAILABLE",
  ],
  ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((attempt): Row => [
    `invalid attempt ${attempt}`,
    (f) => {
      f.observation.runs[0]!.attempt = attempt;
    },
    "INPUT_INVALID",
  ]),
  [
    "malformed PR SHA",
    (f) => {
      f.observation.finalPr.headSha = "bad";
    },
    "INPUT_INVALID",
  ],
  [
    "malformed timestamp",
    (f) => {
      f.observation.finalPr.mergedAt = "yesterday";
    },
    "INPUT_INVALID",
  ],
  [
    "impossible calendar timestamp",
    (f) => {
      f.observation.finalPr.mergedAt = "2026-02-30T10:00:00.000Z";
    },
    "INPUT_INVALID",
  ],
  [
    "future completion",
    (f) => {
      f.observation.runs[0]!.completedAt = "2027-01-01T00:00:00.000Z";
    },
    "INPUT_INVALID",
  ],
  [
    "contradictory merged fields",
    (f) => {
      f.observation.finalPr.mergeSha = null;
    },
    "INPUT_INVALID",
  ],
  [
    "contradictory check fields",
    (f) => {
      f.observation.runs[0]!.checks[0]!.completedAt = null;
    },
    "INPUT_INVALID",
  ],
  [
    "invalid PR id",
    (f) => {
      f.observation.finalPr.number = 0;
    },
    "INPUT_INVALID",
  ],
  [
    "display issue id is not canonical",
    (f) => {
      f.expected.issueId = "forge-1248";
    },
    "INPUT_INVALID",
  ],
  [
    "link belongs to another issue",
    (f) => {
      f.expected.linkKey = "link:work-2:1";
    },
    "INPUT_INVALID",
  ],
  [
    "duplicate run attempt",
    (f) => {
      f.observation.runs.push(structuredClone(f.observation.runs[0]!));
    },
    "INPUT_INVALID",
  ],
  [
    "duplicate check identity",
    (f) => {
      const checks = f.observation.runs[0]!.checks;
      checks.push({ ...checks[0]! });
    },
    "INPUT_INVALID",
  ],
  [
    "too many runs",
    (f) => {
      f.observation.runs = Array.from(
        { length: 257 },
        () => f.observation.runs[0]!,
      );
    },
    "INPUT_INVALID",
  ],
  [
    "too many checks",
    (f) => {
      const run = f.observation.runs[0]!;
      run.checks = Array.from({ length: 257 }, () => run.checks[0]!);
    },
    "INPUT_INVALID",
  ],
];

for (const [name, change, code] of rows) {
  test(
    name,
    () => {
      const f = fixture();
      change(f);
      const before = structuredClone(f);
      const result = evaluateMergeEvidence(
        f.policy,
        f.expected,
        f.observation,
        now,
      );
      expect(result.eligible).toBe(code === null);
      if (result.eligible) {
        expect(
          exitCode({
            ok: true,
            status: "OK",
            op: "merge-evidence",
            result: result.candidate,
            warnings: [],
          }),
        ).toBe(0);
        expect(result.candidate.format).toBe("forge.cloud-merge-evidence/1");
        expect(result.candidate.binding).toEqual(f.expected);
        expect(result.candidate.finalPr.headSha).toBe(f.expected.headSha);
        expect(result.candidate.finalPr.mergeSha).toBe(merge);
        expect(result.candidate.verifiedAt).toBe(now);
        expect(result.candidate.policyDigest).toBe(f.policy.digest);
      } else {
        expect(code).toBe(result.code);
        const envelope = failure(result.code, result.reason);
        expect(envelope.status).toBe("FAIL");
        expect(exitCode(envelope)).toBe(
          code === "INPUT_INVALID" ? 6 : code === "INPUT_CONFLICT" ? 4 : 1,
        );
      }
      expect(f).toEqual(before);
    },
    5_000,
  );
}

const invalidInputs: readonly (readonly [
  string,
  unknown,
  unknown,
  unknown,
  string,
  string,
])[] = [
  ...["outage", "permission", "truncated", "page-cap"].map(
    (
      completeness,
    ): readonly [string, unknown, unknown, unknown, string, string] => [
      `partial ${completeness}`,
      fixture().policy,
      fixture().expected,
      { completeness },
      now,
      "UNAVAILABLE",
    ],
  ),
  [
    "missing policy",
    undefined,
    fixture().expected,
    fixture().observation,
    now,
    "UNAVAILABLE",
  ],
  [
    "forged local receipt",
    fixture().policy,
    fixture().expected,
    { status: "PASS", digest: "f".repeat(64) },
    now,
    "RECEIPT_INVALID",
  ],
  [
    "missing observation",
    fixture().policy,
    fixture().expected,
    undefined,
    now,
    "RECEIPT_INVALID",
  ],
  [
    "malformed observation",
    fixture().policy,
    fixture().expected,
    { runs: null },
    now,
    "INPUT_INVALID",
  ],
  [
    "malformed expected binding",
    fixture().policy,
    null,
    fixture().observation,
    now,
    "INPUT_INVALID",
  ],
  [
    "malformed clock",
    fixture().policy,
    fixture().expected,
    fixture().observation,
    "tomorrow",
    "INPUT_INVALID",
  ],
];
for (const [
  name,
  policy,
  expected,
  observation,
  clock,
  code,
] of invalidInputs) {
  test(
    name,
    () => {
      const before = structuredClone({ policy, expected, observation });
      const result = evaluateMergeEvidence(
        policy,
        expected,
        observation,
        clock,
      );
      expect(result).toMatchObject({ eligible: false, code });
      expect({ policy, expected, observation }).toEqual(before);
    },
    5_000,
  );
}
