import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const state = JSON.parse(readFileSync("fixture.json", "utf8"));
if (state.failRead) process.exit(1);
let result;
if (args[0] === "pr" && args[1] === "checks") {
  result = state.empty
    ? []
    : [
        {
          name: "test",
          bucket: state.pending ? "pending" : state.failed ? "fail" : "pass",
        },
      ];
  if (state.optionalFailed && !args.includes("--required"))
    result.push({ name: "optional", bucket: "fail" });
  if (state.noRequired && args.includes("--required")) result = [];
  if (!result.length) {
    console.error(
      `no ${args.includes("--required") ? "required " : ""}checks reported on the 'fixture' branch`,
    );
    process.exit(1);
  }
} else {
  if (args.includes("--slurp") && args.includes("--jq"))
    throw new Error("GitHub CLI rejects --slurp with --jq");
  if (!args.includes("--jq"))
    throw new Error("Metadata must be projected before capture");
  const metadata = (item, prefix, time) => ({
    id: `${prefix}${item.id}`,
    author: item.user?.login ?? "[deleted]",
    time: item[time],
  });
  if (args[0] === "pr" && args[1] === "view") {
    const comments = (state.issuePages ?? [state.comments ?? []]).flat();
    result = {
      head: (state.head ?? "a").repeat(40),
      state: state.state ?? "OPEN",
      mergeable: state.mergeable ?? "MERGEABLE",
      merge: state.merge ?? "CLEAN",
      review: state.review ?? "APPROVED",
      draft: state.draft ?? false,
      url: "https://github.com/org/repo/pull/7",
      remarks: [
        ...comments.map((item) => metadata(item, "issue", "created_at")),
        ...(state.reviews ?? [])
          .filter((item) => item.state !== "PENDING")
          .map((item) => metadata(item, "review", "submitted_at")),
      ],
    };
  } else if (args[1] === "graphql") {
    const ids = state.threadCount
      ? Array.from(
          { length: state.threadCount },
          (_, index) => `${index}-${"long-thread-id".repeat(20)}`,
        )
      : state.threads
        ? ["thread"]
        : [];
    result = ids.length
      ? Array.from({ length: Math.ceil(ids.length / 100) }, (_, page) => ({
          viewer: "self",
          queued: !!state.queued,
          ids: ids.slice(page * 100, (page + 1) * 100),
          more: state.incomplete || (page + 1) * 100 < ids.length,
        }))
      : [
          {
            viewer: "self",
            queued: !!state.queued,
            ids: [],
            more: !!state.incomplete,
          },
        ];
  } else if (args[1]?.includes("/pulls/7/comments")) {
    result = (state.reviewComments ?? []).map((item) =>
      metadata(item, "inline", "created_at"),
    );
  } else throw new Error("Unexpected fake GitHub request");
}
if (args[1] === "graphql")
  for (const page of result) console.log(JSON.stringify(page));
else console.log(JSON.stringify(result));
