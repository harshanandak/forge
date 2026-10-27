import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const state = JSON.parse(readFileSync("fixture.json", "utf8"));
if (state.failRead) process.exit(1);
const head = (state.head ?? "a").repeat(40);
const connection = (nodes) => ({
  nodes,
  totalCount: nodes.length,
  pageInfo: { hasNextPage: false, endCursor: null },
});
let result;
if (args[0] === "pr" && args[1] === "view") {
  let current = head,
    later = false;
  if (state.moveDuringRead || state.changeMetadata) {
    const count = Number(readFileSync("reads.txt", "utf8")) + 1;
    writeFileSync("reads.txt", String(count));
    later = count > 1;
    if (later && state.moveDuringRead) current = "b".repeat(40);
  }
  result = {
    headRefOid: current,
    state: state.state ?? "OPEN",
    mergeable: state.mergeable ?? "MERGEABLE",
    mergeStateStatus:
      later && state.changeMetadata ? "BLOCKED" : (state.merge ?? "CLEAN"),
    reviewDecision: state.review ?? "APPROVED",
    isDraft: state.draft ?? false,
    url: "https://github.com/org/repo/pull/7",
  };
} else if (args[1] === "graphql") {
  if (args.some((arg) => arg.includes("statusCheckRollup"))) {
    const contexts = connection(
      state.empty
        ? []
        : [
            {
              __typename: "CheckRun",
              name: "test",
              status: state.pending ? "IN_PROGRESS" : "COMPLETED",
              conclusion: state.failed ? "FAILURE" : "SUCCESS",
              isRequired: true,
            },
          ],
    );
    if (state.incomplete)
      contexts.pageInfo = { hasNextPage: true, endCursor: "missing" };
    result = [
      {
        data: {
          repository: {
            object: { oid: head, statusCheckRollup: { contexts } },
          },
        },
      },
    ];
  } else {
    const nodes = state.threads ? [{ id: "thread", isResolved: false }] : [];
    result = [
      {
        data: {
          viewer: { login: "self" },
          repository: {
            pullRequest: {
              mergeQueueEntry: state.queued ? { id: "queue" } : null,
              reviewThreads: connection(nodes),
            },
          },
        },
      },
    ];
  }
} else if (args[1]?.includes("/issues/7/comments"))
  result = state.issuePages ?? [state.comments ?? []];
else if (args[1]?.includes("/pulls/7/reviews")) result = [state.reviews ?? []];
else if (args[1]?.includes("/pulls/7/comments"))
  result = [state.reviewComments ?? []];
else throw new Error("Unexpected fake GitHub request");
console.log(JSON.stringify(result));
