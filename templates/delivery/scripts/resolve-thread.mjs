#!/usr/bin/env node
// Replies in one review thread, then resolves it, and fails unless GitHub reads it back resolved.
// Usage: node resolve-thread.mjs <pr number> <comment id> <thread id> <reply file>.
// The reply comes from a file so no shell ever quotes it. Plain `gh`; the repo and account are gh's own.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const RESOLVE = `mutation($thread: ID!) {
  resolveReviewThread(input: { threadId: $thread }) { thread { id isResolved } } }`;

/** @param {string[]} args @param {(args: string[]) => string} gh @param {(path: string) => string} read */
export function replyAndResolve(args, gh, read) {
  const [pr, comment, thread, file] = args;
  if (
    !/^\d+$/.test(pr ?? "") ||
    !/^\d+$/.test(comment ?? "") ||
    !thread ||
    !file
  )
    throw new Error(
      "usage: resolve-thread.mjs <pr number> <comment id> <thread id> <reply file>",
    );
  const body = read(file).trim();
  if (body === "") throw new Error(`${file} is empty; a resolve needs a reply`);
  const reply = JSON.parse(
    gh([
      "api",
      "--method",
      "POST",
      `repos/{owner}/{repo}/pulls/${pr}/comments/${comment}/replies`,
      "-f",
      `body=${body}`,
    ]),
  );
  const out = JSON.parse(
    gh(["api", "graphql", "-f", `thread=${thread}`, "-f", `query=${RESOLVE}`]),
  );
  const resolved = out?.data?.resolveReviewThread?.thread?.isResolved === true;
  if (!resolved)
    throw new Error(
      `replied (${reply.html_url}) but thread ${thread} is not resolved: ${JSON.stringify(out?.errors ?? out)}`,
    );
  return { replied: reply.id, url: reply.html_url, thread, resolved };
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const gh = (args) => execFileSync("gh", args, { encoding: "utf8" });
    console.log(
      JSON.stringify(
        replyAndResolve(process.argv.slice(2), gh, (path) =>
          readFileSync(path, "utf8"),
        ),
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
