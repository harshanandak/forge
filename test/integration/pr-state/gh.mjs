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
      : /\/(?:pulls|issues)\/(\d+)(?:\/|\?|$)/.exec(args[1] ?? "")?.[1];
if (
  (args[0] === "pr" || args[0] === "api") &&
  !args.some((arg) => arg.includes("node(id:$id)")) &&
  !args[1]?.includes("/compare/") &&
  Number(requested) !== pr
) {
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
  if (
    /\bbody(?:Text|HTML)?\b/i.test(projection) &&
    !args.some((arg) => arg.includes("comments(first:100"))
  )
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
  const editMetadata = (pages, index) => {
    const statusOnly = (edit) =>
      /^[+\s]*(review(\s+status)?|status)[\s:*-]+(running|in\s+progress|queued|pending)[\s.!]*$/i.test(
        edit.diff ?? "",
      );
    return {
      times: pages[index]
        .filter((edit) => !statusOnly(edit))
        .map((edit) => edit.editedAt),
      status: pages[index].filter(statusOnly).map((edit) => edit.editedAt),
      more: index < pages.length - 1,
      cursor: index < pages.length - 1 ? `edit-${index + 1}` : null,
    };
  };
  if (args[0] === "pr" && args[1] === "view") {
    requireProjection(
      "{head:.headRefOid,base:.baseRefOid,baseName:.baseRefName,state,mergeable,merge:.mergeStateStatus,review:.reviewDecision,draft:.isDraft,url,remarks:([.comments[]|{id,author:.author.login,time:.createdAt}]+[.reviews[]|select(.submittedAt)|{id,author:.author.login,time:.submittedAt}])}",
    );
    const comments = (state.issuePages ?? [state.comments ?? []]).flat();
    result = {
      head: head(),
      base: state.base ?? "b".repeat(40),
      baseName: "main",
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
  } else if (
    args[1] === "graphql" &&
    args.some((arg) => arg.includes("commits(first:100"))
  ) {
    paged = true;
    const pages = state.commitPages ?? [state.commits ?? []];
    result = pages.map((commits, index) => ({
      commits,
      more: index < pages.length - 1,
    }));
  } else if (
    args[1] === "graphql" &&
    args.some((arg) => arg.includes("comments(first:100"))
  ) {
    if (
      !projection.includes("edits:(.userContentEdits|{times:[.nodes[]|select(")
    )
      throw new Error("Bot summary bodies and edit diffs must not be captured");
    const pages = state.issuePages ?? [state.comments ?? []];
    if (args.includes("--paginate"))
      throw new Error("Nested connections need independent cursors");
    const cursor = args.find((arg) => arg.startsWith("endCursor="))?.slice(10);
    if (cursor && !/^comment-\d+$/.test(cursor))
      throw new Error("Wrong outer cursor");
    const index = cursor ? Number(cursor.slice(8)) : 0,
      page = pages[index];
    if (!page) throw new Error("Unknown comments cursor");
    result = {
      summaries: page
        .filter(
          (item) =>
            (item.user?.type === "Bot" ||
              item.user?.login?.endsWith("[bot]")) &&
            /review|finding|approved|changes requested/i.test(item.body ?? ""),
        )
        .map((item) => {
          const edits = item.editPages ?? [[]];
          return {
            id: String(item.id),
            time: item.created_at,
            edits: editMetadata(edits, 0),
          };
        }),
      more: state.incompleteSummaries || index < pages.length - 1,
      cursor: index < pages.length - 1 ? `comment-${index + 1}` : null,
    };
  } else if (
    args[1] === "graphql" &&
    args.some((arg) => arg.includes("node(id:$id)"))
  ) {
    if (
      !projection.includes(
        ".data.node.userContentEdits|{times:[.nodes[]|select(",
      ) ||
      !projection.includes("status:[.nodes[]|select(")
    )
      throw new Error(
        "Edit histories must project status and event times only",
      );
    const id = args.find((arg) => arg.startsWith("id="))?.slice(3),
      cursor = args.find((arg) => arg.startsWith("cursor="))?.slice(7);
    if (
      !/^edit-\d+$/.test(cursor ?? "") ||
      args.some((arg) => arg.startsWith("endCursor="))
    )
      throw new Error("Wrong edit cursor");
    const index = Number(cursor.slice(5));
    const item = (state.issuePages ?? [state.comments ?? []])
      .flat()
      .find((comment) => String(comment.id) === id);
    const edits = item.editPages;
    if (!edits[index]) throw new Error("Unknown edit cursor");
    result = editMetadata(edits, index);
  } else if (args[1]?.includes("/compare/")) {
    result = {
      status: state.baseParents?.includes(
        args[1].split("/compare/")[1].split("...")[0],
      )
        ? "ahead"
        : "diverged",
    };
  } else if (args[1]?.includes("/reviews?")) {
    paged = true;
    result = (state.reviewPages ?? [state.reviews ?? []]).map((page) =>
      page
        .filter((item) => item.state !== "PENDING" && item.submitted_at)
        .map((item) => ({ time: item.submitted_at })),
    );
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
    const comments = (state.inlinePages ?? [state.reviewComments ?? []]).flat();
    result = Array.from(
      { length: Math.max(1, Math.ceil(comments.length / 100)) },
      (_, page) =>
        comments.slice(page * 100, (page + 1) * 100).map((item) => ({
          ...metadata(item, "inline", "created_at"),
        })),
    );
  } else throw new Error("Unexpected fake GitHub request");
}
if (paged) for (const page of result) console.log(JSON.stringify(page));
else console.log(JSON.stringify(result));
