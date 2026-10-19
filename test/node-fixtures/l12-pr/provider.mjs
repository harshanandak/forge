import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [installed, file] = process.argv.slice(2);
const load = (path) =>
  import(pathToFileURL(join(installed, "dist/src", path)).href);
const { nodeRunIsolation } = await load("adapters/node-runtime/isolation.js");
const source = readFileSync(
  join(installed, "dist/src/blocks/github/entry.cjs"),
  "utf8",
);
let body = "";
for await (const chunk of process.stdin) body += chunk;
const request = JSON.parse(body);
const stored = JSON.parse(readFileSync(file, "utf8"));
const e = stored.evidence;
if (request.action === "status" && stored.directEvidence) {
  await new Promise((resolve) =>
    process.stdout.write(JSON.stringify({ ok: true, result: e }), resolve),
  );
  process.exit(0);
}
const iso = await nodeRunIsolation.open();
if (!iso.ok) throw new Error("Missing isolation");
const env = {};
const config = {
  envNames: [],
  executable: "fake-gh",
  account: "owner",
  host: "github.com",
  timeoutMs: 20000,
  maxOutputBytes: 1048576,
  pageSize: 100,
  maxPages: 2,
};
const port = {
  capability: "forge.process/v1",
  cwd: process.cwd(),
  resolve: () => ({ kind: "resolved", path: "fake-gh" }),
  async run(_exe, args, options) {
    const input = options.stdin ? JSON.parse(options.stdin) : {};
    const variables = input.variables ?? {};
    let value;
    const core = () => ({
      headRefOid: e.headSha,
      baseRefOid: e.baseSha,
      baseRefName: "main",
      state: e.state,
      isDraft: e.draft,
      mergeable: e.mergeable,
      updatedAt: new Date(e.lastActivityAt).toISOString(),
      baseRef: {
        branchProtectionRule: {
          requiresStrictStatusChecks: e.protection.strictStatusChecks,
          requiresApprovingReviews: stored.classicUnsupported === true,
          requiresCodeOwnerReviews: false,
          restrictsPushes: false,
          requiresCommitSignatures: false,
          requiredStatusChecks: e.requiredChecks.map((v) => ({
            context: v.name,
            appId: v.appId,
          })),
        },
      },
    });
    const connection = (nodes) => ({
      nodes,
      totalCount: nodes.length,
      pageInfo: { hasNextPage: false, endCursor: null },
    });
    if (args.includes("user")) value = { login: stored.login ?? "owner" };
    else if (args.includes("graphql")) {
      let pr;
      if (input.query.includes("ForgePRCore")) pr = core();
      else if (input.query.includes("ForgePRChecks"))
        pr = {
          commits: {
            nodes: [
              {
                commit: {
                  oid: e.headSha,
                  statusCheckRollup: {
                    contexts: connection(
                      e.checks.map((v, index) =>
                        v.appId === null
                          ? {
                              id: `S:${v.name}:${v.headSha}:${index}`,
                              __typename: "StatusContext",
                              context: v.name,
                              state:
                                v.status !== "COMPLETED"
                                  ? "PENDING"
                                  : v.conclusion === "SUCCESS"
                                    ? "SUCCESS"
                                    : "FAILURE",
                              commit: { oid: v.headSha },
                            }
                          : {
                              id: `C:${v.name}:${v.headSha}:${index}`,
                              __typename: "CheckRun",
                              name: v.name,
                              status: v.status,
                              conclusion: v.conclusion,
                              checkSuite: {
                                app: { databaseId: v.appId },
                                commit: { oid: v.headSha },
                              },
                            },
                      ),
                    ),
                  },
                },
              },
            ],
          },
        };
      else if (input.query.includes("ForgePRReviews"))
        pr = {
          reviews: connection(
            e.reviews.map((v) => ({
              id: v.id,
              author: { login: v.author },
              state: v.state,
              commit: { oid: v.headSha },
              updatedAt: new Date(v.updatedAt).toISOString(),
            })),
          ),
        };
      else if (input.query.includes("ForgePRThreads"))
        pr = {
          reviewThreads: connection(
            e.threads.map((v) => ({
              id: v.id,
              isResolved: v.resolved,
              comments: {
                nodes: [
                  { updatedAt: new Date(e.lastActivityAt).toISOString() },
                ],
              },
            })),
          ),
        };
      else if (input.query.includes("ForgePRLabels"))
        pr = {
          labels: connection(
            e.findings
              .filter((v) => !v.resolved)
              .map((v) => ({ name: v.label })),
          ),
        };
      else if (input.query.includes("ForgeResolve")) {
        const thread = e.threads.find((v) => v.id === variables.threadId);
        thread.resolved = true;
        writeFileSync(file, JSON.stringify(stored));
        value = {
          data: {
            resolveReviewThread: {
              thread: { id: thread.id, isResolved: true },
            },
          },
        };
      } else if (input.query.includes("ForgeReply"))
        value = {
          data: {
            addPullRequestReviewThreadReply: { comment: { id: "reply-1" } },
          },
        };
      if (pr) {
        if (stored.malformed && input.query.includes("ForgePRThreads"))
          delete pr.reviewThreads.pageInfo;
        value = { data: { repository: { pullRequest: pr } } };
      }
    } else if (args.some((v) => v.includes("/rules/branches/")))
      value = stored.rules ?? [];
    else if (args.some((v) => v.includes("/compare/"))) {
      if (
        !args.includes(
          `repos/${e.repository}/compare/${e.baseSha}...${e.headSha}`,
        )
      )
        throw new Error("comparison must pin current base and head");
      const behind = e.protection.baseComparison?.behindBy ?? 0;
      value = {
        base_commit: { sha: e.baseSha },
        merge_base_commit: { sha: e.baseSha },
        status: behind > 0 ? "diverged" : "ahead",
        ahead_by: 1,
        behind_by: behind,
      };
    } else if (args.some((v) => v.endsWith("/merge"))) {
      if (input.sha !== e.headSha)
        return {
          exitCode: 1,
          stdout: "",
          stderr: "redacted",
          timedOut: false,
          truncated: false,
          signal: null,
          durationMs: 1,
        };
      if (stored.stealOnMerge) {
        // Host fixture will swap the lease deterministically after the provider returns.
        stored.acceptedLeaseRace = true;
      }
      e.state = "MERGED";
      stored.mergeInput = input;
      writeFileSync(file, JSON.stringify(stored));
      value = { merged: true, sha: "d".repeat(40) };
    } else if (args.some((v) => v.endsWith("/pulls")))
      value = {
        number: e.number,
        html_url: `https://github.com/${e.repository}/pull/${e.number}`,
      };
    else if (args.some((v) => /\/actions\/runs\/\d+$/.test(v)))
      value = {
        id: input.runId ?? 123,
        head_sha: e.headSha,
        pull_requests: [{ number: e.number }],
      };
    else value = {};
    return {
      exitCode: 0,
      stdout: JSON.stringify(value),
      stderr: "",
      timedOut: false,
      truncated: false,
      signal: null,
      durationMs: 1,
    };
  },
};
try {
  const result = JSON.parse(
    await iso.handle.value.run({
      source,
      filename: "github.cjs",
      operation: request.action === "status" ? "github.read" : "github.call",
      args: {
        input: request,
        config,
        services: { process: port, environment: { select: () => env } },
        signal: new AbortController().signal,
        deadline: Date.now() + 30000,
      },
      encode: JSON.stringify,
      fail: (code, message) => {
        throw Object.assign(new Error(message), { code });
      },
      timeoutMs: 30000,
      deadline: Date.now() + 30000,
      signal: new AbortController().signal,
      settled() {},
    }),
  );
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      error: {
        code: error.code ?? "PROVIDER_FAILED",
        message: "Fake provider refused request",
      },
    }),
  );
} finally {
  await iso.handle.close();
}
