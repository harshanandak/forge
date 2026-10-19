import { expect, test, setDefaultTimeout } from "bun:test";
import {
  base,
  call,
  rejection,
  head,
  load,
  processFake,
  reference,
  type Json,
} from "./helpers.ts";
setDefaultTimeout(5000);
const githubConfig = {
  envNames: ["GIT_DIR", "GIT_CONFIG_COUNT"],
  executable: "gh",
  account: "owner",
  host: "github.com",
  timeoutMs: 5000,
  maxOutputBytes: 65536,
  pageSize: 25,
  maxPages: 4,
};
function fixture(query: string): Json {
  if (query.includes("ForgePRHead")) return { headRefOid: head };
  if (query.includes("ForgePRCore"))
    return {
      headRefOid: head,
      baseRefOid: base,
      baseRefName: "main",
      state: "OPEN",
      isDraft: false,
      mergeable: "MERGEABLE",
      updatedAt: "2026-10-18T00:00:00Z",
      baseRef: {
        branchProtectionRule: {
          requiresStrictStatusChecks: false,
          requiresApprovingReviews: false,
          requiresCodeOwnerReviews: false,
          restrictsPushes: false,
          requiresCommitSignatures: false,
          requiredStatusChecks: [{ context: "tests", appId: 7 }],
        },
      },
    };
  const nodes = query.includes("ForgePRChecks")
    ? [
        {
          id: "C1",
          __typename: "CheckRun",
          name: "tests",
          status: "COMPLETED",
          conclusion: "SUCCESS",
          checkSuite: { app: { databaseId: 7 }, commit: { oid: head } },
        },
      ]
    : query.includes("ForgePRReviews")
      ? [
          {
            id: "R1",
            author: { login: "reviewer" },
            state: "APPROVED",
            commit: { oid: head },
            updatedAt: "2026-10-18T00:00:00Z",
          },
        ]
      : query.includes("ForgePRThreads")
        ? [
            {
              id: "T1",
              isResolved: true,
              comments: { nodes: [{ updatedAt: "2026-10-18T00:00:00Z" }] },
            },
          ]
        : [];
  const connection = {
    nodes,
    totalCount: nodes.length,
    pageInfo: { hasNextPage: false, endCursor: null },
  };
  return query.includes("ForgePRChecks")
    ? {
        commits: {
          nodes: [
            {
              commit: {
                oid: head,
                statusCheckRollup: { contexts: connection },
              },
            },
          ],
        },
      }
    : query.includes("ForgePRReviews")
      ? { reviews: connection }
      : query.includes("ForgePRThreads")
        ? { reviewThreads: connection }
        : { labels: connection };
}
function harness(
  options: {
    login?: string;
    mutate?: (value: Json, query: string) => Json;
    config?: Json;
    rules?: readonly Json[];
    comparison?: Json;
    thread?: Json | null;
    run?: Json;
  } = {},
) {
  const args: readonly string[][] = [];
  const calls: string[][] = args as string[][];
  const inputs: Json[] = [];
  const environments: Readonly<Record<string, string>>[] = [];
  const process = processFake((argv, spawn) => {
    calls.push([...argv]);
    environments.push(spawn.env);
    const input = spawn.stdin ? (JSON.parse(spawn.stdin) as Json) : {};
    inputs.push(input);
    if (argv.includes("user")) return { login: options.login ?? "owner" };
    if (argv.includes("graphql")) {
      expect(Object.keys(input).sort()).toEqual(["query", "variables"]);
      expect(input.variables).toBeObject();
      const variables = input.variables as Json;
      const query = String(input.query);
      if (query.includes("ForgeThreadMembership"))
        return {
          data: {
            node:
              options.thread === undefined
                ? {
                    __typename: "PullRequestReviewThread",
                    id: "T1",
                    pullRequest: {
                      number: reference.number,
                      repository: { nameWithOwner: reference.repository },
                    },
                  }
                : options.thread,
          },
        };
      if (query.includes("mutation"))
        return {
          data: {
            addPullRequestReviewThreadReply: { comment: { id: "reply-1" } },
            resolveReviewThread: {
              thread: { id: variables.threadId, isResolved: true },
            },
          },
        };
      const pr = options.mutate?.(fixture(query), query) ?? fixture(query);
      return { data: { repository: { pullRequest: pr } } };
    }
    if (argv.some((v) => v.includes("/rules/branches/")))
      return options.rules ?? [];
    if (argv.some((v) => v.includes("/compare/")))
      return (
        options.comparison ?? {
          base_commit: { sha: base },
          merge_base_commit: { sha: base },
          status: "ahead",
          ahead_by: 1,
          behind_by: 0,
        }
      );
    if (argv.some((v) => v.endsWith("/merge")))
      return {
        merged: true,
        sha: "d".repeat(40),
        message: "Pull Request successfully merged",
      };
    if (argv.some((v) => /\/actions\/runs\/\d+$/.test(v)))
      return (
        options.run ?? {
          id: 123,
          head_sha: head,
          pull_requests: [{ number: reference.number }],
        }
      );
    return { id: 1 };
  });
  const handlers = load("github");
  return {
    calls,
    inputs,
    environments,
    async invoke(
      operation: string,
      input: Json = { action: "status", payload: reference },
    ): Promise<Json> {
      return (await handlers[`github.${operation}`]!(
        call(input, options.config ?? githubConfig, {
          process,
          environment: {
            select: () => ({ GIT_DIR: "/escape", GIT_CONFIG_COUNT: "1" }),
          },
        }),
      )) as Json;
    },
  };
}
for (const policy of ["classic approval", "unsupported ruleset"])
  for (const action of ["reply", "resolve", "rerun"])
    test(`${action} validates its target without merge policy on a ${policy} repository`, async () => {
      const h = harness({
        rules:
          policy === "unsupported ruleset"
            ? [{ type: "merge_queue", parameters: {} }]
            : [],
        mutate(value, query) {
          if (policy !== "classic approval" || !query.includes("ForgePRCore"))
            return value;
          const rule = (value.baseRef as Json).branchProtectionRule as Json;
          return {
            ...value,
            baseRef: {
              branchProtectionRule: { ...rule, requiresApprovingReviews: true },
            },
          };
        },
      });
      expect(
        await h.invoke("call", {
          action,
          payload: {
            ...reference,
            threadId: "T1",
            body: "Targeted reply",
            runId: 123,
          },
        }),
      ).toMatchObject({ accepted: true });
      const queries = h.inputs
        .filter((input) => typeof input.query === "string")
        .map((input) => String(input.query));
      expect(
        queries.some((query) =>
          /ForgePRCore|ForgePRChecks|ForgePRReviews|ForgePRLabels|branchProtectionRule|mergeable/.test(
            query,
          ),
        ),
      ).toBe(false);
      expect(
        h.calls.some((args) =>
          args.some(
            (arg) =>
              arg.includes("/rules/branches/") || arg.includes("/compare/"),
          ),
        ),
      ).toBe(false);
      if (action === "rerun") expect(h.calls.at(-1)).toContain("POST");
      else expect(h.inputs.at(-1)!.variables).toMatchObject({ threadId: "T1" });
    });

test("targeted writes refuse foreign threads, stale runs and a moving head", async () => {
  for (const thread of [
    null,
    { __typename: "Issue", id: "T1" },
    {
      __typename: "PullRequestReviewThread",
      id: "T1",
      pullRequest: {
        number: reference.number + 1,
        repository: { nameWithOwner: reference.repository },
      },
    },
    {
      __typename: "PullRequestReviewThread",
      id: "T1",
      pullRequest: {
        number: reference.number,
        repository: { nameWithOwner: "other/repository" },
      },
    },
  ]) {
    const h = harness({ thread });
    expect(
      await rejection(
        h.invoke("call", {
          action: "resolve",
          payload: { ...reference, threadId: "T1" },
        }),
      ),
    ).toMatchObject({ code: "INPUT_INVALID" });
    expect(
      h.inputs.some((input) => String(input.query).includes("mutation")),
    ).toBe(false);
  }
  for (const run of [
    {
      id: 123,
      head_sha: "c".repeat(40),
      pull_requests: [{ number: reference.number }],
    },
    {
      id: 123,
      head_sha: head,
      pull_requests: [{ number: reference.number + 1 }],
    },
  ]) {
    const h = harness({ run });
    expect(
      await rejection(
        h.invoke("call", {
          action: "rerun",
          payload: { ...reference, runId: 123 },
        }),
      ),
    ).toMatchObject({ code: "INPUT_INVALID" });
    expect(
      h.calls.some((args) =>
        args.some((arg) => arg.endsWith("/rerun-failed-jobs")),
      ),
    ).toBe(false);
  }
  let reads = 0;
  const moving = harness({
    mutate: (value, query) =>
      query.includes("ForgePRHead") && ++reads > 1
        ? { headRefOid: "c".repeat(40) }
        : value,
  });
  expect(
    await rejection(
      moving.invoke("call", {
        action: "rerun",
        payload: { ...reference, runId: 123 },
      }),
    ),
  ).toMatchObject({ code: "HEAD_MOVED" });
  expect(
    moving.calls.some((args) =>
      args.some((arg) => arg.endsWith("/rerun-failed-jobs")),
    ),
  ).toBe(false);
});

test("provider collects exact-head complete paginated evidence through read-only API commands", async () => {
  const h = harness();
  const evidence = await h.invoke("read");
  expect(evidence).toMatchObject({
    ...reference,
    headSha: head,
    mergeableHeadSha: head,
    baseSha: base,
    complete: true,
    requiredChecks: [{ name: "tests", appId: 7 }],
    threads: [{ id: "T1", resolved: true, headSha: head }],
  });
  expect(
    h.calls.every((args) => args.includes("GET") || args.includes("graphql")),
  ).toBe(true);
  expect(
    h.environments.every(
      (env) =>
        !env.GIT_DIR &&
        !env.GIT_CONFIG_COUNT &&
        env.GIT_TERMINAL_PROMPT === "0",
    ),
  ).toBe(true);
});
test("wrong or absent account selection launches no mutation and never switches global auth", async () => {
  const wrong = harness({ login: "other" });
  expect(
    await rejection(
      wrong.invoke("call", {
        action: "merge",
        payload: {
          ...reference,
          expectHead: head,
          expectBase: base,
          title: "Title",
          body: "",
        },
      }),
    ),
  ).toMatchObject({ code: "IDENTITY_MISMATCH" });
  expect(wrong.calls.length).toBe(1);
  expect(wrong.calls.flat()).not.toContain("switch");
  const absent = harness({ config: { ...githubConfig, account: "" } });
  expect(await rejection(absent.invoke("status", {}))).toMatchObject({
    code: "INPUT_INVALID",
  });
  expect(absent.calls.length).toBe(0);
});
test("missing pageInfo, unfinished pages, API errors and head movement never become clean evidence", async () => {
  for (const fault of ["missing", "unfinished", "moved"]) {
    let cores = 0;
    const h = harness({
      mutate(value, query) {
        if (query.includes("ForgePRCore") && ++cores > 1 && fault === "moved")
          return { ...value, headRefOid: "c".repeat(40) };
        if (!query.includes("ForgePRThreads") || fault === "moved")
          return value;
        return {
          ...value,
          reviewThreads: {
            nodes: [],
            totalCount: 1,
            ...(fault === "unfinished"
              ? { pageInfo: { hasNextPage: true, endCursor: "repeat" } }
              : {}),
          },
        };
      },
    });
    expect(await rejection(h.invoke("read"))).toMatchObject({
      code: "INCOMPLETE",
    });
  }
});
test("provider exact-head merge primitive sends explicit squash title/body and refuses trailers", async () => {
  const h = harness();
  expect(
    await h.invoke("call", {
      action: "merge",
      payload: {
        ...reference,
        expectHead: head,
        expectBase: base,
        title: "Explicit title",
        body: "Explicit body",
      },
    }),
  ).toMatchObject({ merged: true, headSha: head });
  expect(h.inputs.at(-1)).toEqual({
    sha: head,
    merge_method: "squash",
    commit_title: "Explicit title",
    commit_message: "Explicit body",
  });
  expect(h.calls.at(-1)).toContain("PUT");
  expect(
    await rejection(
      h.invoke("call", {
        action: "merge",
        payload: {
          ...reference,
          expectHead: head,
          expectBase: base,
          title: "Title",
          body: "Co-authored-by: Tool <x@example.test>",
        },
      }),
    ),
  ).toMatchObject({ code: "INPUT_INVALID" });
});
test("read protocol cannot dispatch mutations or arbitrary API paths", async () => {
  const h = harness();
  expect(
    await rejection(h.invoke("read", { action: "merge", payload: reference })),
  ).toMatchObject({ code: "INPUT_INVALID" });
  expect(
    await rejection(
      h.invoke("call", { action: "api", payload: { path: "/user" } }),
    ),
  ).toMatchObject({ code: "INPUT_INVALID" });
  expect(h.calls.length).toBe(0);
});

test("coercible enum arrays at the GitHub wire boundary are incomplete", async () => {
  for (const field of ["state", "mergeable"]) {
    const h = harness({
      mutate(value, query) {
        return query.includes("ForgePRCore")
          ? { ...value, [field]: [value[field]] }
          : value;
      },
    });
    expect(await rejection(h.invoke("read"))).toMatchObject({
      code: "INCOMPLETE",
    });
  }
  const h = harness({
    mutate(value, query) {
      if (query.includes("ForgePRReviews"))
        return {
          reviews: {
            nodes: [
              {
                id: "R1",
                author: { login: "reviewer" },
                state: ["APPROVED"],
                commit: { oid: head },
                updatedAt: "2026-10-18T00:00:00Z",
              },
            ],
            totalCount: 1,
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      return value;
    },
  });
  expect(await rejection(h.invoke("read"))).toMatchObject({
    code: "INCOMPLETE",
  });
});

test("GitHub preserves each check/review commit and binds aggregate mergeability to its bracketed core head", async () => {
  const old = "c".repeat(40);
  const h = harness({
    mutate(value, query) {
      if (query.includes("ForgePRChecks"))
        return {
          commits: {
            nodes: [
              {
                commit: {
                  oid: head,
                  statusCheckRollup: {
                    contexts: {
                      nodes: [
                        {
                          id: "old-check",
                          __typename: "CheckRun",
                          name: "tests",
                          status: "COMPLETED",
                          conclusion: "SUCCESS",
                          checkSuite: {
                            app: { databaseId: 7 },
                            commit: { oid: old },
                          },
                        },
                      ],
                      totalCount: 1,
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
                },
              },
            ],
          },
        };
      if (query.includes("ForgePRReviews"))
        return {
          reviews: {
            nodes: [
              {
                id: "old-review",
                author: { login: "codex" },
                state: "APPROVED",
                commit: { oid: old },
                updatedAt: "2026-10-18T00:00:00Z",
              },
            ],
            totalCount: 1,
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      return value;
    },
  });
  const observed = await h.invoke("read");
  expect(observed).toMatchObject({
    headSha: head,
    mergeableHeadSha: head,
    checks: [{ headSha: old }],
    reviews: [{ author: "codex", headSha: old }],
  });
});

test("GitHub collects classic and ruleset strict policy with a pinned base comparison", async () => {
  for (const classic of [true, false]) {
    const h = harness({
      rules: classic
        ? []
        : [
            {
              type: "required_status_checks",
              parameters: {
                required_status_checks: [],
                strict_required_status_checks_policy: true,
              },
            },
          ],
      mutate(value, query) {
        if (!query.includes("ForgePRCore")) return value;
        const baseRef = value.baseRef as Json,
          rule = baseRef.branchProtectionRule as Json;
        return {
          ...value,
          baseRef: {
            branchProtectionRule: {
              ...rule,
              requiresStrictStatusChecks: classic,
            },
          },
        };
      },
    });
    expect((await h.invoke("read")).protection).toEqual({
      headSha: head,
      baseSha: base,
      strictStatusChecks: true,
      atomicBaseCondition: false,
      baseComparison: { headSha: head, baseSha: base, behindBy: 0 },
    });
    expect(
      h.calls.some((args) =>
        args.includes(
          `repos/${reference.repository}/compare/${base}...${head}`,
        ),
      ),
    ).toBe(true);
  }
});
test("unmodeled active deployment, queue and PR-review policies are incomplete", async () => {
  for (const type of [
    "required_deployments",
    "merge_queue",
    "pull_request",
    "unrecognized_active_requirement",
  ]) {
    const h = harness({ rules: [{ type, parameters: {} }] });
    expect(await rejection(h.invoke("read"))).toMatchObject({
      code: "INCOMPLETE",
    });
  }
  const classic = harness({
    mutate(value, query) {
      if (!query.includes("ForgePRCore")) return value;
      const baseRef = value.baseRef as Json,
        rule = baseRef.branchProtectionRule as Json;
      return {
        ...value,
        baseRef: {
          branchProtectionRule: { ...rule, requiresApprovingReviews: true },
        },
      };
    },
  });
  expect(await rejection(classic.invoke("read"))).toMatchObject({
    code: "INCOMPLETE",
  });
});

test("strict policy refuses missing flags, stale bases and inconsistent comparison responses", async () => {
  const strict = (value: Json, query: string): Json => {
    if (!query.includes("ForgePRCore")) return value;
    const rule = (value.baseRef as Json).branchProtectionRule as Json;
    return {
      ...value,
      baseRef: {
        branchProtectionRule: { ...rule, requiresStrictStatusChecks: true },
      },
    };
  };
  for (const comparison of [
    {
      base_commit: { sha: "d".repeat(40) },
      merge_base_commit: { sha: base },
      status: "ahead",
      ahead_by: 1,
      behind_by: 0,
    },
    {
      base_commit: { sha: base },
      merge_base_commit: { sha: base },
      status: "behind",
      ahead_by: 0,
      behind_by: 0,
    },
    {
      base_commit: { sha: base },
      merge_base_commit: { sha: base },
      status: "ahead",
      ahead_by: 1,
    },
  ])
    expect(
      await rejection(harness({ comparison, mutate: strict }).invoke("read")),
    ).toMatchObject({ code: "INCOMPLETE" });
  const unknown = harness({
    mutate(value, query) {
      const result = strict(value, query);
      if (query.includes("ForgePRCore"))
        (
          (result.baseRef as Json).branchProtectionRule as Json
        ).requiresStrictStatusChecks = undefined;
      return result;
    },
  });
  expect(await rejection(unknown.invoke("read"))).toMatchObject({
    code: "INCOMPLETE",
  });
  expect(
    await rejection(
      harness({
        rules: [
          {
            type: "required_status_checks",
            parameters: { required_status_checks: [] },
          },
        ],
      }).invoke("read"),
    ),
  ).toMatchObject({ code: "INCOMPLETE" });
  let cores = 0;
  const moved = harness({
    mutate(value, query) {
      const result = strict(value, query);
      return query.includes("ForgePRCore") && ++cores > 1
        ? { ...result, baseRefOid: "d".repeat(40) }
        : result;
    },
  });
  expect(await rejection(moved.invoke("read"))).toMatchObject({
    code: "INCOMPLETE",
  });
});

test("GitHub direct merge refuses strict policy and changed base before issuing its mutation", async () => {
  const input = {
    action: "merge",
    payload: {
      ...reference,
      expectHead: head,
      expectBase: base,
      title: "Explicit title",
      body: "Explicit body",
    },
  };
  const strict = harness({
    mutate(value, query) {
      if (!query.includes("ForgePRCore")) return value;
      const rule = (value.baseRef as Json).branchProtectionRule as Json;
      return {
        ...value,
        baseRef: {
          branchProtectionRule: { ...rule, requiresStrictStatusChecks: true },
        },
      };
    },
  });
  expect(await rejection(strict.invoke("call", input))).toMatchObject({
    code: "INCOMPLETE",
  });
  expect(strict.calls.some((args) => args.includes("PUT"))).toBe(false);
  const moved = harness({
    mutate: (value, query) =>
      query.includes("ForgePRCore")
        ? { ...value, baseRefOid: "d".repeat(40) }
        : value,
  });
  expect(await rejection(moved.invoke("call", input))).toMatchObject({
    code: "BASE_MOVED",
  });
  expect(moved.calls.some((args) => args.includes("PUT"))).toBe(false);
});
