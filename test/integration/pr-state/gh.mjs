import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const state = JSON.parse(readFileSync("fixture.json", "utf8"));
if (state.failRead) process.exit(1);
const pr = Number(state.pr ?? process.env.FAKE_GH_PR ?? 7);
const head = () => {
  const value = state.head ?? process.env.FAKE_GH_HEAD ?? "a";
  return value.length === 1 ? value.repeat(40) : value;
};
const requested =
  args[0] === "pr" && ["view", "checks"].includes(args[1])
    ? args[2]
    : args[0] === "api" && args[1] === "graphql"
      ? args.find((arg) => /^n=/.test(arg))?.slice(2)
      : /\/pulls\/(\d+)(?:\/|\?|$)/.exec(args[1] ?? "")?.[1];
if ((args[0] === "pr" || args[0] === "api") && Number(requested) !== pr) {
  console.error(
    `fake gh: expected pull request ${pr}, got ${requested ?? "none"}`,
  );
  process.exit(1);
}
let result;
let paged = false;
const fields = args[args.indexOf("--json") + 1];
if (args[0] === "pr" && args[1] === "view" && fields === "headRefOid,state") {
  if (args.includes("--jq"))
    throw new Error("Final identity read must capture the raw small object");
  if (state.afterHead !== undefined) state.head = state.afterHead;
  if (state.afterState !== undefined) state.state = state.afterState;
  delete state.afterHead;
  delete state.afterState;
  writeFileSync("fixture.json", JSON.stringify(state));
  result = {
    headRefOid: head(),
    state: state.state ?? "OPEN",
  };
} else if (args[0] === "pr" && args[1] === "checks") {
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
  const projection = args[args.indexOf("--jq") + 1].replace(/\s+/g, "");
  if (/\bbody(?:Text|HTML)?\b/i.test(projection))
    throw new Error("Projection must not capture comment or review bodies");
  const requireProjection = (expected) => {
    if (projection !== expected)
      throw new Error(`Unexpected metadata projection: ${projection}`);
  };
  const metadata = (item, prefix, time) => ({
    id: `${prefix}${item.id}`,
    author: item.user?.login ?? "[deleted]",
    time: item[time],
  });
  if (args[0] === "pr" && args[1] === "view") {
    requireProjection(
      "{head:.headRefOid,state,mergeable,merge:.mergeStateStatus,review:.reviewDecision,draft:.isDraft,url,remarks:([.comments[]|{id,author:.author.login,time:.createdAt}]+[.reviews[]|select(.submittedAt)|{id,author:.author.login,time:.submittedAt}])}",
    );
    const comments = (state.issuePages ?? [state.comments ?? []]).flat();
    result = {
      head: head(),
      state: state.state ?? "OPEN",
      mergeable: state.mergeable ?? "MERGEABLE",
      merge: state.merge ?? "CLEAN",
      review: state.review ?? "APPROVED",
      draft: state.draft ?? false,
      url: state.url ?? `https://github.com/org/repo/pull/${pr}`,
      remarks: [
        ...comments.map((item) => metadata(item, "issue", "created_at")),
        ...(state.reviews ?? [])
          .filter((item) => item.state !== "PENDING")
          .map((item) => metadata(item, "review", "submitted_at")),
      ],
    };
  } else if (args[1] === "graphql") {
    paged = true;
    const ids = state.threadCount
      ? Array.from(
          { length: state.threadCount },
          (_, index) => `${index}-${"long-thread-id".repeat(4)}`,
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
  } else if (/\/pulls\/\d+\/comments\?/.test(args[1] ?? "")) {
    requireProjection(
      "[.[]|{id:(.id|tostring),author:(.user.login//(.user|tostring)),time:.created_at}]|@json",
    );
    if (!args.includes("--paginate") || !args[1].endsWith("?per_page=100"))
      throw new Error("Inline comments must request every page of 100");
    paged = true;
    const comments = state.reviewComments ?? [];
    result = Array.from(
      { length: Math.max(1, Math.ceil(comments.length / 100)) },
      (_, page) =>
        comments
          .slice(page * 100, (page + 1) * 100)
          .map((item) => metadata(item, "inline", "created_at")),
    );
  } else throw new Error("Unexpected fake GitHub request");
}
if (paged) for (const page of result) console.log(JSON.stringify(page));
else console.log(JSON.stringify(result));
