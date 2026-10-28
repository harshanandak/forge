import { spawnSync } from "node:child_process";

try {
  const [owner, repo, number, ...extra] = process.argv.slice(2);
  if (!owner || !repo || !/^\d+$/.test(number ?? "") || extra.length)
    throw new Error("Usage: node list-threads.mjs owner repo PR");
  const query = `query($owner:String!,$repo:String!,$pr:Int!,$cursor:String){
    repository(owner:$owner,name:$repo){pullRequest(number:$pr){
      reviewThreads(first:100,after:$cursor){nodes{id isResolved path line comments(first:1){nodes{fullDatabaseId author{login} body}}}
        pageInfo{hasNextPage endCursor}}}}}`;
  const rows = [];
  let cursor = null;
  do {
    const result = spawnSync("gh", ["api", "graphql", "--input", "-"], {
      input: JSON.stringify({
        query,
        variables: { owner, repo, pr: Number(number), cursor },
      }),
      env: process.env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error || result.status !== 0)
      throw new Error("gh review-thread query failed");
    const response = JSON.parse(result.stdout);
    const page = response.data?.repository?.pullRequest?.reviewThreads;
    if (
      response.errors?.length ||
      !Array.isArray(page?.nodes) ||
      typeof page.pageInfo?.hasNextPage !== "boolean"
    )
      throw new Error("Incomplete review-thread response");
    for (const thread of page.nodes) {
      if (thread == null)
        throw new Error(
          "Incomplete review-thread response: null thread; rerun the list helper",
        );
      if (thread?.isResolved) continue;
      const comment = thread?.comments?.nodes?.[0];
      rows.push(
        JSON.stringify({
          id: thread?.id ?? null,
          commentId:
            comment?.fullDatabaseId == null
              ? null
              : String(comment.fullDatabaseId),
          path: thread?.path ?? null,
          line: thread?.line ?? null,
          author: comment?.author?.login ?? null,
          body: Array.from(comment?.body ?? "")
            .slice(0, 200)
            .join(""),
        }),
      );
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    if (page.pageInfo.hasNextPage && (typeof cursor !== "string" || !cursor))
      throw new Error("Incomplete review-thread pagination");
  } while (cursor !== null);
  if (rows.length) console.log(rows.join("\n"));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
