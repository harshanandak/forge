#!/usr/bin/env node
// Lists a PR's unresolved review threads as JSON, one object per thread, from any author.
// Usage: node review-threads.mjs <pr number>. Plain `gh`; the repo and account are gh's own.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const QUERY = `query($owner: String!, $name: String!, $pr: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $pr) {
    reviewThreads(first: 100) { pageInfo { hasNextPage } nodes {
      id isResolved path line
      comments(first: 1) { nodes { databaseId author { login } body } } } } } } }`;

/** @param {string[]} args @param {(args: string[]) => string} gh @returns {object[]} */
export function listThreads(args, gh) {
  const pr = args[0];
  if (pr === undefined || !/^\d+$/.test(pr))
    throw new Error("usage: review-threads.mjs <pr number>");
  const out = JSON.parse(
    gh([
      "api",
      "graphql",
      "-F",
      "owner={owner}",
      "-F",
      "name={repo}",
      "-F",
      `pr=${pr}`,
      "-f",
      `query=${QUERY}`,
    ]),
  );
  const threads = out?.data?.repository?.pullRequest?.reviewThreads;
  if (threads === undefined)
    throw new Error(
      `no pull request #${pr}: ${JSON.stringify(out?.errors ?? out)}`,
    );
  if (threads.pageInfo?.hasNextPage)
    console.error(
      "warning: more than 100 threads; only the first 100 were read",
    );
  return threads.nodes
    .filter((thread) => !thread.isResolved)
    .map((thread) => {
      const first = thread.comments.nodes[0];
      const body = (first?.body ?? "").replace(/\s+/g, " ").trim();
      return {
        thread: thread.id,
        comment: first?.databaseId ?? null,
        path: thread.path,
        line: thread.line,
        author: first?.author?.login ?? null,
        body: body.length > 120 ? `${body.slice(0, 117)}...` : body,
      };
    });
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const gh = (args) =>
      execFileSync("gh", args, {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
    console.log(
      JSON.stringify(listThreads(process.argv.slice(2), gh), null, 2),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
