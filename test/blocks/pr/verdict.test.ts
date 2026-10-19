import { test, expect } from "bun:test";
import type { Policy } from "../../../src/blocks/pr/verdict.ts";
import { verdict } from "../../../src/blocks/pr/verdict.ts";
import { contracts, schemaRef } from "../../../src/blocks/pr/contract.ts";
import {
  ready,
  policy,
  now,
  oldHead,
} from "../../node-fixtures/pr/evidence.ts";
const future = "2099-01-01T00:00:00Z",
  later = "2026-10-20T00:00:01Z";
const check = ready().checks[0]!,
  review = ready().reviews[0]!;
const gap = (area: string) => [{ area, code: "UNREADABLE" }];
const requirement = (state: string) => [
  {
    kind: "merge_queue",
    source: "ruleset",
    enforcedBy: "host",
    state,
    reason: "Host rule",
  },
];
function changed(path: string, value: unknown): unknown {
  const e: unknown = ready();
  let parent = e;
  const parts = path.split(".");
  for (const key of parts.slice(0, -1))
    parent = (parent as Record<string, unknown>)[key];
  (parent as Record<string, unknown>)[parts.at(-1)!] = value;
  return e;
}
const rows: readonly (readonly [string, unknown, string, string])[] = [
  ["core", null, "INCOMPLETE", "CORE_UNREADABLE"],
  ["gaps", gap("core"), "INCOMPLETE", "CORE_UNREADABLE"],
  ["gaps", gap("reviews"), "INCOMPLETE", "EVIDENCE_GAP"],
  ["requirements", requirement("unknown"), "INCOMPLETE", "REQUIREMENT_UNKNOWN"],
  [
    "requirements",
    requirement("unsatisfied"),
    "BLOCKED",
    "REQUIREMENT_UNSATISFIED",
  ],
  [
    "requirements",
    requirement("pending"),
    "CHECKS_PENDING",
    "REQUIREMENT_PENDING",
  ],
  ["core.host.canBypass", true, "INCOMPLETE", "BYPASS_CAPABLE"],
  ["core.host.canBypass", null, "INCOMPLETE", "BYPASS_CAPABLE"],
  ["core.mergeable", "UNKNOWN", "INCOMPLETE", "MERGEABILITY_UNKNOWN"],
  ["core.host.mergeStateStatus", "BLOCKED", "INCOMPLETE", "HOST_BLOCKED"],
  ["core.draft", true, "DRAFT", "DRAFT"],
  ["core.mergeable", "CONFLICTING", "CONFLICTING", "CONFLICTING"],
  ["checks.0.conclusion", "FAILURE", "CHECKS_FAILED", "CHECK_FAILED"],
  ["checks.0.status", "IN_PROGRESS", "CHECKS_PENDING", "CHECK_PENDING"],
  ["checks.0.conclusion", "FUTURE", "INCOMPLETE", "CHECK_STATE_UNKNOWN"],
  ["checks.0.headSha", oldHead, "CHECKS_PENDING", "CHECK_PENDING"],
  ["reviews.0.state", "CHANGES_REQUESTED", "REVIEW_BLOCKED", "REVIEW_BLOCKED"],
  ["reviews.0.state", "PENDING", "REVIEW_BLOCKED", "REVIEW_BLOCKED"],
  ["reviews.0.commitSha", oldHead, "REVIEW_REQUIRED", "REVIEW_REQUIRED"],
  ["reviews.0.authorizing", false, "REVIEW_REQUIRED", "REVIEW_REQUIRED"],
  ["reviews.0.author", "ghost", "REVIEW_REQUIRED", "REVIEW_REQUIRED"],
  ["reviews.0.author", null, "REVIEW_REQUIRED", "REVIEW_REQUIRED"],
  ["core.host.allowedMergeMethods", [], "BLOCKED", "MERGE_METHOD_UNAVAILABLE"],
  ["labels", ["hold"], "BLOCKED", "BLOCKING_LABEL"],
  ["observedAt", future, "INCOMPLETE", "EVIDENCE_GAP"],
  ["core.updatedAt", future, "INCOMPLETE", "EVIDENCE_GAP"],
  ["checks.0.startedAt", future, "INCOMPLETE", "EVIDENCE_GAP"],
  ["reviews.0.updatedAt", future, "INCOMPLETE", "EVIDENCE_GAP"],
  [
    "checks",
    [check, { ...check, conclusion: "FAILURE" }],
    "INCOMPLETE",
    "CHECK_ORDER_AMBIGUOUS",
  ],
  ["checks.0.startedAt", null, "INCOMPLETE", "CHECK_ORDER_AMBIGUOUS"],
  [
    "requiredChecks",
    [...ready().requiredChecks, { name: "test", appId: 2, strict: false }],
    "INCOMPLETE",
    "CHECK_ORDER_AMBIGUOUS",
  ],
  [
    "reviews",
    [review, { ...review, id: "other" }],
    "INCOMPLETE",
    "REVIEW_ORDER_AMBIGUOUS",
  ],
  ["reviews.0.submittedAt", null, "INCOMPLETE", "REVIEW_ORDER_AMBIGUOUS"],
];
for (const [path, value, status, code] of rows)
  test(`${path}: ${JSON.stringify(value)}`, () => {
    const result = verdict(changed(path, value), policy, now);
    expect(result.status).toBe(status);
    expect(result.blockers.some((b) => b.code === code)).toBe(true);
    expect(contracts.validator(schemaRef("Verdict"))(result).ok).toBe(true);
  }, 1000);
const evaluate = (
  patch: Record<string, unknown> = {},
  config: Policy = policy,
) => verdict({ ...ready(), ...patch }, config, now);
test("authorized baseline is ready and immutable", () => {
  const e = ready(),
    before = JSON.stringify(e);
  expect(verdict(e, policy, now).status).toBe("MERGE_READY");
  expect(JSON.stringify(e)).toBe(before);
}, 1000);
test("core gaps beat terminal; terminal beats every non-core gap", () => {
  for (const state of ["CLOSED", "MERGED"]) {
    const core = { ...ready().core, state, draft: true };
    expect(evaluate({ core, gaps: gap("core") }).status).toBe("INCOMPLETE");
    for (const area of ["checks", "reviews", "threads", "labels", "policy"])
      expect(evaluate({ core, gaps: gap(area) }).status).toBe(state);
  }
}, 1000);
test("old-head change requests and pending reviews block", () => {
  for (const state of ["CHANGES_REQUESTED", "PENDING"])
    expect(
      evaluate({ reviews: [{ ...review, state, commitSha: oldHead }] }).status,
    ).toBe("REVIEW_BLOCKED");
}, 1000);
test("submission order across heads ignores body edits and input order", () => {
  const reviews = [
    { ...review, updatedAt: "2026-10-20T00:00:09Z" },
    {
      ...review,
      id: "later",
      state: "CHANGES_REQUESTED",
      commitSha: oldHead,
      submittedAt: later,
    },
  ];
  expect(evaluate({ reviews }).status).toBe("REVIEW_BLOCKED");
  expect(evaluate({ reviews: reviews.reverse() }).status).toBe(
    "REVIEW_BLOCKED",
  );
  reviews[0] = {
    ...reviews[0]!,
    state: "APPROVED",
    commitSha: ready().core.headSha,
  };
  expect(evaluate({ reviews }).status).toBe("MERGE_READY");
}, 1000);
test("non-authorizing, ghost, deleted, commented and dismissed reviews cannot block", () => {
  for (const extra of [
    { authorizing: false },
    { author: null },
    { author: "ghost" },
    { state: "COMMENTED" },
    { state: "DISMISSED" },
  ]) {
    const outsider = {
      ...review,
      id: "outsider",
      author: "outsider",
      state: "CHANGES_REQUESTED",
      ...extra,
    };
    expect(evaluate({ reviews: [review, outsider] }).status).toBe(
      "MERGE_READY",
    );
  }
}, 1000);
test("new non-authorizing review supersedes old approval; outsider ties do not block", () => {
  const newer = {
    ...review,
    id: "new",
    authorizing: false,
    submittedAt: later,
  };
  expect(evaluate({ reviews: [review, newer] }).status).toBe("REVIEW_REQUIRED");
  const outsider = { ...review, author: "outsider", authorizing: false };
  expect(
    evaluate({ reviews: [review, outsider, { ...outsider, id: "two" }] })
      .status,
  ).toBe("MERGE_READY");
}, 1000);
test("latest check wins and stale or superseded observations are reported", () => {
  const checks = [
    { ...check, conclusion: "FAILURE" },
    { ...check, startedAt: later },
    { ...check, headSha: oldHead },
  ];
  const result = evaluate({ checks });
  expect(result.status).toBe("MERGE_READY");
  expect(result.ignored.length).toBe(2);
}, 1000);
test("no-check policy and optional checks are configurable", () => {
  const empty = { checks: [], requiredChecks: [] };
  expect(evaluate(empty).status).toBe("INCOMPLETE");
  expect(evaluate(empty).blockers.some((b) => b.code === "NO_CHECKS")).toBe(
    true,
  );
  expect(evaluate(empty, { ...policy, allowNoChecks: true }).status).toBe(
    "MERGE_READY",
  );
  const checks = [check, { ...check, name: "optional", conclusion: "FAILURE" }];
  expect(evaluate({ checks }).status).toBe("CHECKS_FAILED");
  expect(
    evaluate({ checks }, { ...policy, optionalChecks: "ignore" }).status,
  ).toBe("MERGE_READY");
}, 1000);
test("approval count and settling use explicit policy and review edit time", () => {
  expect(evaluate({}, { ...policy, minApprovals: 2 }).status).toBe(
    "REVIEW_REQUIRED",
  );
  expect(evaluate({}, { ...policy, settleMs: 10001 }).status).toBe("SETTLING");
  expect(evaluate({}, { ...policy, settleMs: 10000 }).status).toBe(
    "MERGE_READY",
  );
  expect(
    evaluate(
      { reviews: [{ ...review, updatedAt: later }] },
      { ...policy, settleMs: 10000 },
    ).status,
  ).toBe("SETTLING");
}, 1000);
test("strict-behind checks and every blocker survive precedence", () => {
  const core = {
    ...ready().core,
    host: { ...ready().core.host, mergeStateStatus: "BEHIND" },
  };
  expect(
    evaluate({
      core,
      requiredChecks: [{ name: "test", appId: 1, strict: true }],
    }).status,
  ).toBe("CHECKS_PENDING");
  const result = evaluate({
    core: { ...core, draft: true, mergeable: "CONFLICTING" },
    labels: ["hold"],
    reviews: [],
  });
  expect(result.status).toBe("DRAFT");
  for (const code of [
    "DRAFT",
    "CONFLICTING",
    "BLOCKING_LABEL",
    "REVIEW_REQUIRED",
  ])
    expect(result.blockers.some((b) => b.code === code)).toBe(true);
}, 1000);
test("activity equal to the read clock still restarts settling", () => {
  const observedAt = later;
  const result = evaluate(
    { observedAt, reviews: [{ ...review, updatedAt: later }] },
    { ...policy, settleMs: 10000 },
  );
  expect(result.status).toBe("SETTLING");
}, 1000);
