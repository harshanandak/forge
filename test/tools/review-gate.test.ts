import { expect, test } from "bun:test";
import { existsSync } from "node:fs";

const repo = "harshanandak/forge";
const head = "a".repeat(40);
const old = "b".repeat(40);
const base = `repos/${repo}`;
const pushedAt = Date.parse("2026-11-22T08:00:00Z");
const iso = (offset = 0) => new Date(pushedAt + offset).toISOString();
const codex = { type: "Bot", login: "chatgpt-codex-connector[bot]" };
const rabbit = { type: "Bot", login: "coderabbitai[bot]" };
const human = { type: "User", login: "reviewer" };

function summary(
  sha = head,
  any = false,
  unresolved = false,
  status = "completed",
) {
  return {
    user: codex,
    created_at: iso(),
    body: `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 ${JSON.stringify(
      {
        code_review: {
          commit_sha: sha,
          status,
          has_any_findings: any,
          has_unresolved_findings: unresolved,
        },
      },
    )} -->`,
  };
}

const review = {
  id: 24,
  user: rabbit,
  state: "COMMENTED",
  commit_id: head,
  submitted_at: iso(200),
  body: "<!-- coderabbit-ai-generated:v1 -->\n\n**Actionable comments posted: 0**",
};
const quota = {
  user: codex,
  created_at: iso(100),
  body: "You have reached your Codex usage limits for code reviews.",
};
const finding = {
  user: codex,
  created_at: iso(500),
  body: "<!-- codex-code-review-finding:v1 -->",
};

type Comment = ReturnType<typeof summary>;
type Evidence = {
  head: string;
  pushedAt: number;
  comments: Comment[];
  reviews: (typeof review)[];
  findings: (typeof finding & { pull_request_review_id?: number })[];
  threads: { isResolved: boolean }[];
};
type Row = {
  at: number;
  pr: number;
  head: string;
  kind: string;
  verdict: string;
  p1: number;
  note: string;
};
type Decision = {
  state: string;
  description: string;
  requests: string[];
  standIns: string[];
};
type Api = (endpoint: string, ...args: string[]) => unknown;
type Guard = {
  mainRed: boolean;
  securityPathNeedsSol: boolean;
  securitySolPass: boolean;
};

const path = "../../tools/ci/review-gate.ts";
const gate = existsSync(new URL(path, import.meta.url))
  ? ((await import(path)) as {
      decide(
        evidence: Evidence,
        rows: Row[],
        guard: Guard,
        now: number,
      ): Decision;
      readEvidence(api: Api, repo: string, pr: number): Evidence;
      request(
        api: Api,
        repo: string,
        pr: number,
        head: string,
        decision: Decision,
      ): void;
      publish(
        api: Api,
        repo: string,
        pr: number,
        head: string,
        decision: Decision,
        append: (row: string) => void,
        now: number,
      ): void;
      audit(api: Api, repo: string, since: string, rows: Row[]): unknown;
    })
  : undefined;

const clean: Evidence = {
  head,
  pushedAt,
  comments: [summary()],
  reviews: [review],
  findings: [],
  threads: [{ isResolved: true }],
};
const guard: Guard = {
  mainRed: false,
  securityPathNeedsSol: false,
  securitySolPass: false,
};
const sol: Row = {
  at: pushedAt + 1000,
  pr: 18,
  head,
  kind: "sol",
  verdict: "PASS",
  p1: 0,
  note: "findings checked",
};
const full = { ...sol, note: "xhigh full review" };
const p1 = {
  ...sol,
  head: old,
  kind: "sonnet-temp",
  verdict: "BLOCK",
  p1: 1,
  at: pushedAt,
};
const evaluate = (
  evidence: Partial<Evidence> = {},
  rows: Row[] = [],
  guards: Partial<Guard> = {},
  elapsed = 60_000,
) =>
  gate?.decide(
    { ...clean, ...evidence },
    rows,
    { ...guard, ...guards },
    pushedAt + elapsed,
  );

test("clean exact-head bot reviews succeed without Sol", () => {
  expect(evaluate()).toEqual({
    state: "success",
    description: "codex; coderabbit",
    requests: [],
    standIns: [],
  });
}, 1000);

test("stale summary requests Codex once and a current in-progress summary suppresses the request", () => {
  const stale = { comments: [summary(old)] };
  expect(evaluate(stale)?.requests).toEqual(["codex"]);
  expect(evaluate(stale)?.state).toBe("failure");
  expect(
    evaluate({
      comments: [
        ...stale.comments,
        { user: human, created_at: iso(500), body: "@codex review" },
      ],
    })?.requests,
  ).toEqual([]);
  expect(
    evaluate({ comments: [summary(head, false, false, "in_progress")] })
      ?.requests,
  ).toEqual([]);
}, 1000);

test("quota and the exact ten-minute boundary require a full Sol stand-in", () => {
  expect(evaluate({ comments: [quota] })?.standIns).toEqual(["codex"]);
  expect(evaluate({ comments: [quota] }, [sol])?.state).toBe("failure");
  expect(evaluate({ comments: [quota] }, [full])?.description).toBe(
    "sol stand-in: codex quota; coderabbit",
  );
  expect(
    evaluate({ comments: [{ ...quota, created_at: iso(-1) }] }, [full])?.state,
  ).toBe("failure");
  expect(evaluate({ comments: [] }, [full], {}, 599_999)?.state).toBe(
    "failure",
  );
  expect(evaluate({ comments: [] }, [], {}, 600_000)?.standIns).toEqual([
    "codex",
  ]);
  expect(evaluate({ comments: [] }, [], {}, 600_000)?.state).toBe("failure");
  expect(
    evaluate({ comments: [], reviews: [] }, [full], {}, 600_000)?.description,
  ).toBe("sol stand-in: codex timeout; sol stand-in: coderabbit timeout");
}, 1000);

test("CodeRabbit quota uses the same stand-in rule", () => {
  const notice = { ...quota, user: rabbit, body: "Review rate limit exceeded" };
  expect(
    evaluate({ comments: [summary(), notice], reviews: [] }, [full])
      ?.description,
  ).toBe("codex; sol stand-in: coderabbit quota");
}, 1000);

test("a cumulative finding needs a Sol pass after its creation, including on an older head", () => {
  const prior = { comments: [summary(head, true)], findings: [finding] };
  expect(evaluate(prior)?.state).toBe("failure");
  expect(evaluate({ ...prior, findings: [] }, [sol])?.state).toBe("failure");
  expect(evaluate(prior, [{ ...sol, head: old }])?.state).toBe("success");
  expect(
    evaluate(
      { ...prior, findings: [finding, { ...finding, created_at: iso(1100) }] },
      [sol],
    )?.state,
  ).toBe("failure");
  expect(
    evaluate({ ...prior, comments: [summary(head, true, true)] }, [sol])?.state,
  ).toBe("failure");
}, 1000);

test("CodeRabbit findings remain obligations after thread resolution", () => {
  const withFinding = {
    reviews: [{ ...review, body: review.body.replace(": 0**", ": 1**") }],
    findings: [{ ...finding, user: rabbit, pull_request_review_id: review.id }],
  };
  expect(evaluate(withFinding)?.state).toBe("failure");
  expect(evaluate(withFinding, [sol])?.state).toBe("success");
  expect(evaluate({ ...withFinding, findings: [] }, [sol])?.state).toBe(
    "failure",
  );
}, 1000);

test("only a later exact-head Sol pass clears a P1 block", () => {
  for (const replacement of [
    { ...sol, kind: "lead-check" },
    { ...sol, kind: "sonnet-temp" },
    { ...sol, head: old },
    { ...sol, at: p1.at },
    { ...sol, p1: 1 },
  ]) {
    expect(evaluate({}, [p1, replacement])?.state).toBe("failure");
  }
  expect(evaluate({}, [p1, sol])?.state).toBe("success");
  expect(evaluate({ comments: [summary(old)] }, [p1, sol])?.state).toBe(
    "failure",
  );
  expect(
    evaluate({}, [sol, { ...sol, at: sol.at + 1, verdict: "BLOCK" }])?.state,
  ).toBe("failure");
}, 1000);

test("red main, security path without the newest Sol pass and unresolved threads block", () => {
  expect(evaluate({}, [sol], { mainRed: true })?.state).toBe("failure");
  const security = { securityPathNeedsSol: true, securitySolPass: true };
  expect(evaluate({}, [], security)?.state).toBe("failure");
  expect(evaluate({}, [sol], security)?.state).toBe("success");
  expect(
    evaluate({}, [sol], { ...security, securitySolPass: false })?.state,
  ).toBe("failure");
  expect(evaluate({ threads: [{ isResolved: false }] }, [sol])?.state).toBe(
    "failure",
  );
}, 1000);

test("an untrusted author or unknown summary format cannot grant success", () => {
  expect(
    evaluate({ comments: [{ ...summary(), user: { ...codex, type: "User" } }] })
      ?.state,
  ).toBe("failure");
  expect(evaluate({ reviews: [{ ...review, user: human }] })?.state).toBe(
    "failure",
  );
  expect(
    evaluate(
      {
        comments: [
          {
            ...summary(),
            body: summary().body.replace("state:v1", "state:v2"),
          },
        ],
      },
      [full],
      {},
      600_000,
    )?.state,
  ).toBe("failure");
}, 1000);

function github(hasNextPage: boolean): Api {
  return (endpoint, ...args) => {
    if (endpoint === "graphql") {
      expect(args.join(" ")).toContain("reviewThreads(first:100)");
      return {
        data: {
          repository: {
            pullRequest: {
              headRefOid: head,
              reviewThreads: {
                pageInfo: { hasNextPage },
                nodes: clean.threads,
              },
            },
          },
        },
      };
    }
    if (endpoint === `${base}/pulls/18`) return { head: { sha: head } };
    expect(args).toContain("--paginate");
    expect(args).toContain("--slurp");
    if (endpoint.startsWith(`${base}/actions/workflows/ci.yml/runs?`)) {
      expect(endpoint).toContain(`head_sha=${head}`);
      expect(endpoint).toContain("event=pull_request");
      return [
        {
          workflow_runs: [
            {
              head_sha: head,
              event: "pull_request",
              created_at: iso(),
              pull_requests: [{ number: 18 }],
            },
          ],
        },
      ];
    }
    if (endpoint.includes("/issues/18/comments")) return [[summary()], [quota]];
    if (endpoint.includes("/pulls/18/reviews")) return [[review]];
    if (endpoint.includes("/pulls/18/comments")) return [[], [finding]];
    throw new Error(`Unexpected data source: ${endpoint}`);
  };
}

test("reader combines REST pages and refuses truncated threads", () => {
  expect(gate?.readEvidence(github(false), repo, 18)).toEqual({
    ...clean,
    comments: [summary(), quota],
    findings: [finding],
  });
  expect(() => gate?.readEvidence(github(true), repo, 18)).toThrow("threads");
}, 1000);

const success: Decision = {
  state: "success",
  description: "codex; coderabbit",
  requests: [],
  standIns: [],
};
const status = {
  context: "Review Gate",
  state: "success",
  description: success.description,
  created_at: iso(1000),
};

test("publisher writes the ledger first and posts only to the evaluated SHA", () => {
  const calls: string[] = [];
  const transport: Api = (endpoint, ...args) => {
    calls.push([endpoint, ...args].join(" "));
    return [[]];
  };
  gate?.publish(
    transport,
    repo,
    18,
    head,
    success,
    (row) => calls.push(row),
    pushedAt + 1000,
  );
  expect(calls[0]).toContain(`/commits/${head}/statuses`);
  expect(calls[1]).toContain(
    `\t18\t${head}\t\treview-gate\tPASS\t0\t0\t${success.description}`,
  );
  expect(calls[2]).toContain(`/statuses/${head}`);
  expect(calls[2]).toContain("context=Review Gate");
  expect(() =>
    gate?.publish(
      transport,
      repo,
      18,
      head,
      success,
      () => {
        throw new Error("Ledger write failed");
      },
      pushedAt,
    ),
  ).toThrow("Ledger write failed");
  expect(calls).toHaveLength(4);
}, 1000);

test("publisher skips the identical latest Review Gate status", () => {
  let reads = 0;
  gate?.publish(
    (endpoint) => {
      expect(endpoint).toContain("/commits/");
      reads++;
      return [[{ ...status, context: "Other check" }, status]];
    },
    repo,
    18,
    head,
    success,
    () => {
      throw new Error("Unexpected ledger append");
    },
    pushedAt,
  );
  expect(reads).toBe(1);
}, 1000);

test("requests carry the reviewed head and only go to bots in the decision", () => {
  const calls: string[] = [];
  gate?.request(
    (endpoint, ...args) => calls.push([endpoint, ...args].join(" ")),
    repo,
    18,
    head,
    { ...success, requests: ["coderabbit"] },
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain(`${base}/issues/18/comments`);
  expect(calls[0]).toContain("@coderabbitai review");
  expect(calls[0]).toContain(head);
}, 1000);

test("audit joins merged final heads to status rows and reports unmatched writes and merge delay", () => {
  const transport: Api = (endpoint, ...args) => {
    expect(args).not.toContain("POST");
    if (endpoint.startsWith("search/issues?"))
      return [
        { incomplete_results: false, total_count: 1, items: [{ number: 18 }] },
      ];
    if (endpoint === `${base}/pulls/18`)
      return { number: 18, head: { sha: head }, merged_at: iso(4000) };
    if (endpoint.includes("/statuses"))
      return [
        [
          {
            ...status,
            id: 2,
            description: "sol stand-in: codex timeout; coderabbit",
          },
          { ...status, id: 1, created_at: iso(0) },
        ],
      ];
    if (endpoint.includes("/check-runs"))
      return [
        {
          check_runs: [
            { name: "CI Gate", conclusion: "success", completed_at: iso(2000) },
          ],
        },
      ];
    throw new Error(`Unexpected audit source: ${endpoint}`);
  };
  const result = gate?.audit(transport, repo, iso(), [
    {
      ...sol,
      kind: "review-gate",
      note: "sol stand-in: codex timeout; coderabbit",
    },
  ]);
  expect(result).toMatchObject({
    merged: [{ pr: 18, head, delayMs: 2000 }],
    unmatched: [{ pr: 18, head, id: 1 }],
    standIns: { codex: 1, coderabbit: 0 },
  });
}, 1000);
