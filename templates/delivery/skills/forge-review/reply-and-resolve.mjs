import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

try {
  const [owner, repo, pr, comment, thread, file, ...extra] =
    process.argv.slice(2);
  if (
    !owner ||
    !repo ||
    !/^\d+$/.test(pr ?? "") ||
    !/^\d+$/.test(comment ?? "") ||
    !thread ||
    !file ||
    extra.length
  )
    throw new Error(
      "Usage: node reply-and-resolve.mjs owner repo PR comment-id thread-id reply-file",
    );
  const api = (args, payload) => {
    const result = spawnSync("gh", ["api", ...args, "--input", "-"], {
      input: JSON.stringify(payload),
      env: process.env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    });
    if (result.error || result.status !== 0)
      throw new Error("gh review-thread mutation failed");
    const response = JSON.parse(result.stdout);
    if (response.errors?.length)
      throw new Error("GitHub rejected review-thread mutation");
    return response;
  };
  const reply = api(
    [
      "--method",
      "POST",
      `repos/${owner}/${repo}/pulls/${pr}/comments/${comment}/replies`,
    ],
    {
      body: readFileSync(file, "utf8"),
    },
  );
  if (!Number.isInteger(reply.id))
    throw new Error("GitHub did not confirm the reply");
  const resolved = api(["graphql"], {
    query:
      "mutation($thread:ID!){resolveReviewThread(input:{threadId:$thread}){thread{isResolved}}}",
    variables: { thread },
  });
  if (resolved.data?.resolveReviewThread?.thread?.isResolved !== true)
    throw new Error("GitHub did not confirm resolution");
  console.log("true");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
