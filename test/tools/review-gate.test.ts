import { expect, test } from "bun:test";
import { existsSync } from "node:fs";

const head = "a".repeat(40);
const old = "b".repeat(40);
const start = Date.parse("2026-11-22T09:00:00Z");
const deadline = start + 600_000;
const codex = { type: "Bot", login: "chatgpt-codex-connector[bot]" };
const rabbit = { type: "Bot", login: "coderabbitai[bot]" };
const summaryMarker = "<!-- codex-pull-request-review-summary -->";
const codexQuota = "You have reached your Codex usage limits for code reviews.";

function summary(commit = head, any = false, unresolved = false) {
  const code_review = {
    commit_sha: commit,
    status: "completed",
    has_any_findings: any,
    has_unresolved_findings: unresolved,
  };
  return {
    author: codex,
    at: start + 10,
    body: `${summaryMarker}\n<!-- codex-review-state:v1 ${JSON.stringify({ code_review })} -->`,
  };
}

const rabbitReview = {
  author: rabbit,
  at: start + 20,
  head,
  id: 24,
  state: "COMMENTED",
  body: "<!-- coderabbit-ai-generated:v1 -->\n\n**Actionable comments posted: 0**",
};
const historicalRabbit = { ...rabbitReview, head: old, id: 23 };
const rabbitFinding = {
  author: rabbit,
  at: start + 40,
  reviewId: historicalRabbit.id,
};
const quota = { author: codex, at: start + 30, body: codexQuota };
const finding = { author: codex, at: start + 40 };

type Finding = typeof finding & { reviewId?: number };
const clean = {
  head,
  pushedAt: start,
  now: start + 60_000,
  comments: [summary()],
  reviews: [rabbitReview],
  findings: [] as Finding[],
  threads: [true],
  truncated: false,
};
const guard = {
  mainRed: false,
  securityPathNeedsSol: false,
  securitySolPass: false,
};
const security = { securityPathNeedsSol: true, securitySolPass: true };
const sol = {
  at: start + 1000,
  head,
  kind: "sol",
  verdict: "PASS",
  p1: 0,
  note: "findings checked",
};
const full = { ...sol, note: "review finished scope=full" };
const p1 = {
  ...sol,
  at: start,
  head: old,
  kind: "sonnet-temp",
  verdict: "PASS",
  p1: 1,
};

type Decision = { state: "success" | "failure"; description: string };
type Case = {
  name: string;
  expected: Decision;
  evidence?: Partial<typeof clean>;
  rows?: (typeof sol)[];
  guards?: Partial<typeof guard>;
};
const passed = (description = "codex; coderabbit"): Decision => ({
  state: "success",
  description,
});
const blocked = (description: string): Decision => ({
  state: "failure",
  description,
});
const withFinding = { comments: [summary(head, true)], findings: [finding] };
const conflictingState = summary(head, true, true).body.slice(
  summaryMarker.length,
);

const cases: Case[] = [
  { name: "clean exact-head reviews pass without Sol", expected: passed() },
  {
    name: "a clock earlier than the push cannot pass",
    evidence: { now: start - 1 },
    expected: blocked("invalid clock"),
  },
  {
    name: "a non-finite elapsed time cannot pass",
    evidence: { now: NaN },
    expected: blocked("invalid clock"),
  },
  {
    name: "a ledger pass dated after the decision cannot count",
    rows: [{ ...sol, at: clean.now + 1 }],
    expected: blocked("invalid ledger time"),
  },
  {
    name: "a negative ledger P1 count is invalid",
    rows: [{ ...sol, p1: -1 }],
    expected: blocked("invalid P1 count"),
  },
  {
    name: "a fractional ledger P1 count is invalid",
    rows: [{ ...sol, p1: 0.5 }],
    expected: blocked("invalid P1 count"),
  },
  {
    name: "stale Codex summary withholds success",
    evidence: { comments: [summary(old)] },
    expected: blocked("waiting for codex"),
  },
  {
    name: "two Codex summary comments fail closed even across heads",
    evidence: { comments: [summary(old), summary()] },
    expected: blocked("unknown codex summary"),
  },
  {
    name: "a conflicting second state record blocks a clean Codex summary",
    evidence: {
      comments: [{ ...summary(), body: summary().body + conflictingState }],
    },
    expected: blocked("unknown codex summary"),
  },
  {
    name: "an unknown second state record also blocks a clean Codex summary",
    evidence: {
      comments: [
        {
          ...summary(),
          body:
            summary().body + conflictingState.replace("state:v1", "state:v2"),
        },
      ],
    },
    expected: blocked("unknown codex summary"),
  },
  {
    name: "CodeRabbit formal review must cover the exact head",
    evidence: { reviews: [{ ...rabbitReview, head: old }] },
    expected: blocked("waiting for coderabbit"),
  },
  {
    name: "fresh Codex quota requires a full Sol review",
    evidence: { comments: [quota] },
    rows: [sol],
    expected: blocked("Sol needed: codex quota"),
  },
  {
    name: "full exact-head Sol can stand in for Codex on quota",
    evidence: { comments: [quota] },
    rows: [full],
    expected: passed("sol stand-in: codex quota; coderabbit"),
  },
  {
    name: "old quota does not start a stand-in early",
    evidence: { comments: [{ ...quota, at: start - 1 }] },
    rows: [full],
    expected: blocked("waiting for codex"),
  },
  {
    name: "CodeRabbit quota uses the same stand-in rule",
    evidence: {
      reviews: [],
      comments: [
        summary(),
        { ...quota, author: rabbit, body: "Review rate limit exceeded" },
      ],
    },
    rows: [full],
    expected: passed("codex; sol stand-in: coderabbit quota"),
  },
  {
    name: "the ten-minute deadline uses the CI run timestamp",
    evidence: { comments: [], now: deadline - 1 },
    rows: [full],
    expected: blocked("waiting for codex"),
  },
  {
    name: "the ten-minute timeout alone cannot pass",
    evidence: { comments: [], now: deadline },
    expected: blocked("Sol needed: codex timeout"),
  },
  {
    name: "one full exact-head Sol review can cover both timed-out bots",
    evidence: { comments: [], reviews: [], now: deadline },
    rows: [full],
    expected: passed(
      "sol stand-in: codex timeout; sol stand-in: coderabbit timeout",
    ),
  },
  {
    name: "a finding created after the previous Sol pass blocks",
    evidence: withFinding,
    rows: [{ ...sol, at: finding.at - 1 }],
    expected: blocked("unchecked codex findings"),
  },
  {
    name: "the Sol pass must be strictly later than the finding",
    evidence: withFinding,
    rows: [{ ...sol, at: finding.at }],
    expected: blocked("unchecked codex findings"),
  },
  {
    name: "a cumulative finding can be covered by a Sol pass on an older head",
    evidence: withFinding,
    rows: [{ ...sol, head: old }],
    expected: passed(),
  },
  {
    name: "a completed summary with missing finding evidence blocks",
    evidence: { comments: [summary(head, true)] },
    rows: [full],
    expected: blocked("incomplete codex findings"),
  },
  {
    name: "an unresolved Codex finding blocks even after a Sol pass",
    evidence: { ...withFinding, comments: [summary(head, true, true)] },
    rows: [full],
    expected: blocked("incomplete codex findings"),
  },
  {
    name: "an exact-head CodeRabbit review with missing reported findings blocks",
    evidence: {
      reviews: [
        { ...rabbitReview, body: rabbitReview.body.replace(": 0**", ": 1**") },
      ],
    },
    rows: [sol],
    expected: blocked("incomplete coderabbit review"),
  },
  {
    name: "resolved CodeRabbit findings still need a later Sol pass",
    evidence: {
      findings: [{ ...finding, author: rabbit, reviewId: rabbitReview.id }],
    },
    expected: blocked("unchecked coderabbit findings"),
  },
  ...[
    ["unaccounted findings", rabbitReview.body.replace(": 0**", ": 1**")],
    ["a missing count", "<!-- coderabbit-ai-generated:v1 -->"],
    ["a malformed count", rabbitReview.body.replace(": 0**", ": unknown**")],
  ].map(([caseName, body]) => ({
    name: `historical CodeRabbit review with ${caseName} blocks a clean head`,
    evidence: { reviews: [rabbitReview, { ...historicalRabbit, body: body! }] },
    expected: blocked("incomplete coderabbit review"),
  })),
  {
    name: "a checked historical CodeRabbit finding permits current coverage",
    evidence: {
      reviews: [
        rabbitReview,
        {
          ...historicalRabbit,
          body: historicalRabbit.body.replace(": 0**", ": 1**"),
        },
      ],
      findings: [rabbitFinding],
    },
    rows: [sol],
    expected: passed(),
  },
  ...[
    { ...sol, kind: "lead-check" },
    { ...sol, kind: "sonnet-temp" },
    { ...sol, head: old },
    { ...sol, at: p1.at },
  ].map((pass, i) => ({
    name: `P1 stays blocked with ${["lead-check", "sonnet-temp", "a stale Sol pass", "a tied Sol pass"][i]}`,
    rows: [p1, pass],
    expected: blocked("Sol blocked"),
  })),
  {
    name: "P1 clears with a later Sol pass on this head",
    rows: [sol, p1],
    expected: passed(),
  },
  {
    name: "P1 clearance still needs both bots or full stand-ins",
    evidence: { comments: [summary(old)] },
    rows: [p1, sol],
    expected: blocked("waiting for codex"),
  },
  {
    name: "a new Sol block on this head overrides an earlier pass",
    rows: [sol, { ...sol, at: sol.at + 1, verdict: "BLOCK" }],
    expected: blocked("Sol blocked"),
  },
  ...["not a full review", "scope=full-summary", "other-scope=full"].map(
    (note) => ({
      name: `a finding check with note "${note}" cannot stand in for a missing bot review`,
      evidence: { comments: [], now: deadline },
      rows: [{ ...sol, note }],
      expected: blocked("Sol needed: codex timeout"),
    }),
  ),
  {
    name: "security paths need a Sol pass on this head",
    rows: [{ ...sol, head: old }],
    guards: security,
    expected: blocked("security path needs Sol"),
  },
  {
    name: "security paths also need the supplied guard pass",
    rows: [sol],
    guards: { ...security, securitySolPass: false },
    expected: blocked("security path needs Sol"),
  },
  {
    name: "security paths pass with both sources of exact-head Sol evidence",
    rows: [sol],
    guards: security,
    expected: passed(),
  },
  {
    name: "red main withholds success",
    guards: { mainRed: true },
    expected: blocked("main CI is red"),
  },
  {
    name: "truncated threads withhold success",
    evidence: { truncated: true },
    expected: blocked("truncated threads"),
  },
  {
    name: "any unresolved thread withholds success",
    evidence: { threads: [true, false] },
    expected: blocked("open threads"),
  },
  {
    name: "a human cannot forge Codex coverage using the bot login",
    evidence: {
      comments: [{ ...summary(), author: { ...codex, type: "User" } }],
    },
    expected: blocked("waiting for codex"),
  },
  {
    name: "a different bot cannot grant CodeRabbit coverage",
    evidence: { reviews: [{ ...rabbitReview, author: codex }] },
    expected: blocked("waiting for coderabbit"),
  },
  ...[
    [
      "malformed JSON",
      `${summaryMarker}\n<!-- codex-review-state:v1 {broken} -->`,
    ],
    ["unknown version", summary().body.replace("state:v1", "state:v2")],
    ["short SHA", summary(head.slice(0, 7)).body],
    [
      "unknown findings boolean",
      summary().body.replace(
        '"has_any_findings":false',
        '"has_any_findings":null',
      ),
    ],
  ].map(([format, body]) => ({
    name: `Codex ${format} fails even after timeout`,
    evidence: { comments: [{ ...summary(), body: body! }], now: deadline },
    rows: [full],
    expected: blocked("unknown codex summary"),
  })),
];

const modulePath = "../../tools/ci/review-gate.ts";
const gate = existsSync(new URL(modulePath, import.meta.url))
  ? ((await import(modulePath)) as {
      decide(
        evidence: typeof clean,
        rows: (typeof sol)[],
        guards: typeof guard,
      ): Decision;
    })
  : undefined;

test.each(cases)(
  "$name",
  ({ expected, evidence, rows, guards }) => {
    expect(
      gate?.decide({ ...clean, ...evidence }, rows ?? [], {
        ...guard,
        ...guards,
      }),
    ).toEqual(expected);
  },
  1000,
);
