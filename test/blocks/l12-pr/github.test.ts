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
      if (query.includes("mutation"))
        return {
          data: {
            resolveReviewThread: {
              thread: { id: variables.threadId, isResolved: true },
            },
          },
        };
      const pr = options.mutate?.(fixture(query), query) ?? fixture(query);
      return { data: { repository: { pullRequest: pr } } };
    }
    if (argv.some((v) => v.includes("/rules/branches/"))) return [];
    if (argv.some((v) => v.endsWith("/merge")))
      return {
        merged: true,
        sha: "d".repeat(40),
        message: "Pull Request successfully merged",
      };
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
test("provider collects exact-head complete paginated evidence through read-only API commands", async () => {
  const h = harness();
  const evidence = await h.invoke("read");
  expect(evidence).toMatchObject({
    ...reference,
    headSha: head,
    baseSha: base,
    complete: true,
    requiredChecks: [{ name: "tests", appId: 7 }],
    threads: [{ id: "T1", resolved: true }],
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
        payload: { ...reference, expectHead: head, title: "Title", body: "" },
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
