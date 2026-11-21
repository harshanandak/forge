import { expect, test } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createProcessPort } from "../../../src/adapters/process/index.ts";
import { createRunnerOutput } from "../../../src/adapters/runner-output/index.ts";
import {
  createCheck,
  type CheckConfig,
} from "../../../src/blocks/check/index.ts";
import type { StateRecord } from "../../../src/generated/types.ts";
import { gitExecutable } from "../../../tools/git-executable.ts";
import { gitFixtureDirectory } from "../../fixtures/git-resolution.ts";
import { removeQuietly, spawnBudget } from "../../spawn-budget.ts";
import { captured } from "./fakes.ts";

const cases = [
  "identical update",
  "extra merge content",
  "wrong first parent",
  "reversed parents",
  "three parents",
  "two merge bases",
  "shallow history",
  "missing reviewed object",
  "clean replace ref over changed content",
] as const;
const timeout = 30_000;
const config: CheckConfig = {
  commands: { probe: "probe" },
  timeoutMs: 10_000,
  maxOutputBytes: 8192,
  outputHeadBytes: 1024,
  outputTailBytes: 1024,
  maxMetadataBytes: 32768,
  maxReceiptBytes: 262144,
  report: "exit-code",
  stopOnFailure: true,
  inputs: [],
  maxInputBytes: 1048576,
  environment: [],
  gate: { requiredReviews: [{ kind: "merge-gate", reviewer: "reviewer" }] },
};

function history(
  root: string,
  gitPath: string,
  scenario: (typeof cases)[number],
) {
  const budget = spawnBudget(timeout);
  const git = (args: string[], input?: string) =>
    budget.run(args[0]!, gitPath, args, { cwd: root, input }, 0).stdout.trim();
  git(["init", "-q", "--object-format=sha1"]);
  git(["config", "user.name", "Forge fixture"]);
  git(["config", "user.email", "fixture@example.test"]);
  const blob = (content: string) =>
    git(["hash-object", "-w", "--stdin"], content);
  const tree = (files: Record<string, string>) =>
    git(
      ["mktree"],
      Object.entries(files)
        .map(([file, oid]) => `100644 blob ${oid}\t${file}\n`)
        .join(""),
    );
  const commit = (treeId: string, ...parents: string[]) =>
    git([
      "commit-tree",
      treeId,
      ...parents.flatMap((parent) => ["-p", parent]),
      "-m",
      "fixture",
    ]);
  const fork = commit(tree({}));
  const feature = blob("reviewed feature\n");
  const upstream = blob("upstream change\n");
  let reviewed = commit(tree({ "feature.txt": feature }), fork);
  let base = commit(tree({ "upstream.txt": upstream }), fork);
  const clean = tree({ "feature.txt": feature, "upstream.txt": upstream });
  if (scenario === "two merge bases") {
    const left = commit(clean, reviewed);
    const right = commit(clean, base);
    reviewed = commit(clean, left, right);
    base = commit(clean, right, left);
    expect(
      git(["merge-base", "--all", reviewed, base]).split(/\r?\n/).sort(),
    ).toEqual([left, right].sort());
  }
  const dirty =
    scenario === "extra merge content" ||
    scenario === "clean replace ref over changed content";
  const mergeTree = dirty
    ? tree({ "feature.txt": blob("unreviewed\n"), "upstream.txt": upstream })
    : clean;
  const parents = [reviewed, base];
  if (scenario === "wrong first parent") parents[0] = fork;
  if (scenario === "reversed parents") parents.reverse();
  if (scenario === "three parents") parents.push(fork);
  const head = commit(mergeTree, ...parents);
  if (scenario === "shallow history")
    writeFileSync(join(root, ".git", "shallow"), head + "\n");
  if (scenario === "missing reviewed object")
    unlinkSync(
      join(root, ".git", "objects", reviewed.slice(0, 2), reviewed.slice(2)),
    );
  if (scenario === "clean replace ref over changed content")
    git(["replace", head, commit(clean, reviewed, base)]);
  return { head, reviewed, base };
}

function githubReply(
  args: readonly string[],
  head: string,
  base: string,
  reviewed: string,
): string {
  const pageInfo = { hasNextPage: false, endCursor: null };
  const check = {
    __typename: "CheckRun",
    name: "CI Gate",
    status: "COMPLETED",
    conclusion: "SUCCESS",
    isRequired: true,
  };
  if (args[0] === "pr" && args[1] === "view")
    return JSON.stringify({
      headRefOid: head,
      headRefName: "feat/x",
      baseRefOid: base,
      state: "OPEN",
      mergeStateStatus: "CLEAN",
      url: "https://github.com/org/repo/pull/7",
      changedFiles: 1,
      author: { login: "builder" },
    });
  if (args.some((arg) => arg.includes("statusCheckRollup"))) {
    const object = {
      oid: head,
      statusCheckRollup: {
        contexts: { totalCount: 1, pageInfo, nodes: [check] },
      },
    };
    return JSON.stringify([{ data: { repository: { object } } }]);
  }
  if (args.some((arg) => arg.includes("reviewThreads"))) {
    const pullRequest = { reviewThreads: { nodes: [], pageInfo } };
    return JSON.stringify([{ data: { repository: { pullRequest } } }]);
  }
  if (args[1]?.includes("/compare/"))
    return JSON.stringify([
      {
        status: "ahead",
        base_commit: { sha: base },
        files: [{ filename: "feature.txt", status: "modified" }],
      },
    ]);
  if (args[1]?.includes("/issues/7/comments"))
    return (
      "codex-review-state:v1 " +
      JSON.stringify({
        code_review: {
          commit_sha: head,
          status: "completed",
          has_unresolved_findings: false,
        },
      })
    );
  if (args[1]?.includes("/pulls/7/reviews?"))
    return JSON.stringify([
      {
        id: 1,
        body: "forge-review:merge-gate",
        user: { login: "reviewer" },
        commit_id: reviewed,
        state: "APPROVED",
        submitted_at: "2026-11-21T11:00:00Z",
      },
    ]);
  throw new Error("Unexpected fixture command: " + args.join(" "));
}

test.each(cases)(
  "the carry gate uses real Git for %s",
  async (scenario) => {
    const root = gitFixtureDirectory("forge-review-carry-");
    try {
      const gitPath = gitExecutable();
      const { head, base, reviewed } = history(root, gitPath, scenario);
      const port = createProcessPort();
      let stored: StateRecord | undefined;
      const gate = createCheck({
        root,
        environment: { SystemRoot: process.env.SystemRoot ?? "" },
        clock: { now: Date.now },
        output: createRunnerOutput(),
        snapshot: () =>
          Promise.resolve({ head, filesDigest: "sha256:" + "a".repeat(64) }),
        state: {
          get: () => stored,
          list: () => (stored ? [stored] : []),
          events: () => [],
          put(key, value) {
            return (stored = {
              key,
              value,
              namespace: "check",
              revision: 1,
              updatedAt: new Date().toISOString(),
              updatedBy: { kind: "human", id: "fixture" },
            });
          },
        },
        process: {
          ...port,
          resolve: (name) => ({
            kind: "resolved",
            path: name === "git" ? gitPath : name,
          }),
          async run(executable, args, options) {
            if (executable.path === gitPath)
              return port.run(executable, args, options);
            return captured(
              {
                stdout:
                  executable.path === "gh"
                    ? githubReply(args, head, base, reviewed)
                    : "checked",
                stderr: "",
                exitCode: 0,
                signal: null,
                timedOut: false,
                truncated: false,
                durationMs: 1,
              },
              options,
            );
          },
        },
      });
      expect((await gate.run({}, config)).status).toBe("PASS");
      const result = await gate.gate({ pr: 7 }, config);
      if (scenario === "identical update") {
        expect(result.reasons).toEqual([]);
        expect(result).toMatchObject({
          verdict: "PASS",
          reviews: [{ head, carriedFrom: reviewed, base }],
        });
      } else {
        expect(result.verdict).toBe("REFUSED");
        expect(result.reasons).toEqual([
          {
            code: "REQUIRED_REVIEW_NOT_COVERED",
            detail:
              "Required merge-gate does not cover the current PR head; review this head and record its result before merging.",
          },
        ]);
      }
    } finally {
      removeQuietly(root);
    }
  },
  timeout,
);
