import type { HandlerArgs } from "../../contract/author.ts";
import type { ProcessPort } from "../../ports/process.ts";
import type { BlockerCode } from "./contract.ts";
type Input = {
  repo: string;
  number: number;
  expectHead?: string;
  unresolved?: boolean;
  commentId?: number;
  body?: string;
  threadId?: string;
};
type Services = {
  process: ProcessPort;
  files: { root: string };
  environment: {
    select(names: readonly string[]): Readonly<Record<string, string>>;
  };
};
type Call = HandlerArgs<
  Input,
  { requireResolvedThreads?: boolean; excerptChars?: number },
  Services
>;
const reason = (code: BlockerCode, message: string) => ({ code, message });
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid GitHub response");
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Invalid GitHub list");
  return value;
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : "GitHub command failed";
}
function client(call: Call) {
  const env = call.services.environment.select(
    "PATH PATHEXT SystemRoot HOME USERPROFILE GH_TOKEN GITHUB_TOKEN GH_CONFIG_DIR APPDATA XDG_CONFIG_HOME DBUS_SESSION_BUS_ADDRESS HTTPS_PROXY HTTP_PROXY NO_PROXY https_proxy http_proxy no_proxy".split(
      " ",
    ),
  );
  const executable = call.services.process.resolve("gh", env);
  return async (args: string[], json = true): Promise<unknown> => {
    if (executable.kind !== "resolved")
      throw new Error("UNAVAILABLE: gh is not installed");
    const result = await call.services.process.run(executable, args, {
      cwd: call.services.files.root,
      env,
      signal: call.signal,
      timeoutMs: Math.max(1, call.deadline - Date.now()),
      maxOutputBytes: 1048576,
    });
    if (
      result.exitCode !== 0 ||
      result.timedOut ||
      result.truncated ||
      result.signal
    )
      throw new Error(result.stderr || "GitHub command did not complete");
    return json ? (JSON.parse(result.stdout) as unknown) : null;
  };
}
const ref = (input: Input) => [String(input.number), "--repo", input.repo];
const view = (input: Input, fields: string) => [
  "pr",
  "view",
  ...ref(input),
  "--json",
  fields,
];
async function status(call: Call) {
  let head: string | null = null,
    state = "UNKNOWN",
    verdict = "BLOCKED";
  const reasons: ReturnType<typeof reason>[] = [];
  const add = (code: BlockerCode, text: string) =>
    reasons.push(reason(code, text));
  if (!/^[\w.-]+\/[\w.-]+$/.test(call.input.repo))
    return {
      head,
      state,
      verdict: "UNAVAILABLE",
      reasons: [
        reason(
          "HOST_BLOCKED",
          "Only GitHub owner/repository references are supported",
        ),
      ],
    };
  try {
    const gh = client(call);
    const pr = object(
      await gh(
        view(
          call.input,
          "number,state,isDraft,headRefOid,baseRefName,mergeStateStatus,reviewDecision,statusCheckRollup",
        ),
      ),
    );
    if (
      typeof pr.headRefOid !== "string" ||
      typeof pr.state !== "string" ||
      typeof pr.isDraft !== "boolean" ||
      typeof pr.mergeStateStatus !== "string"
    )
      throw new Error("Invalid GitHub PR response");
    head = pr.headRefOid;
    state = pr.state;
    const [owner, name] = call.input.repo.split("/");
    const query =
      "query($owner:String!,$name:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){isMergeQueueEnabled reviewThreads(first:100,after:$endCursor){nodes{isResolved} pageInfo{hasNextPage endCursor}}}}}";
    const pages = array(
      await gh([
        "api",
        "graphql",
        "--paginate",
        "--slurp",
        "-f",
        `query=${query}`,
        "-f",
        `owner=${owner}`,
        "-f",
        `name=${name}`,
        "-F",
        `number=${call.input.number}`,
      ]),
    );
    if (!pages.length) throw new Error("Missing review threads");
    let unresolved = 0,
      mergeQueue = false;
    for (const page of pages) {
      const data = object(page);
      if (data.errors) throw new Error("GitHub could not read review threads");
      const pull = object(object(object(data.data).repository).pullRequest);
      if (typeof pull.isMergeQueueEnabled !== "boolean")
        throw new Error("Missing merge queue status");
      mergeQueue ||= pull.isMergeQueueEnabled;
      const threads = object(pull.reviewThreads);
      for (const node of array(threads.nodes)) {
        const thread = object(node);
        if (typeof thread.isResolved !== "boolean")
          throw new Error("Invalid review thread");
        if (!thread.isResolved) unresolved++;
      }
    }
    if (call.config.requireResolvedThreads !== false && unresolved)
      add("REQUIREMENT_UNSATISFIED", `${unresolved} unresolved review threads`);
    const review = pr.reviewDecision;
    if (review === "CHANGES_REQUESTED" || review === "REVIEW_REQUIRED")
      add(
        review === "CHANGES_REQUESTED" ? "REVIEW_BLOCKED" : "REVIEW_REQUIRED",
        review,
      );
    if (state === "MERGED" || state === "CLOSED") verdict = state;
    else if (mergeQueue) {
      verdict = "UNSUPPORTED";
      add("MERGE_METHOD_UNAVAILABLE", "The base branch requires a merge queue");
    } else if (pr.isDraft) verdict = "DRAFT";
    else if (pr.mergeStateStatus === "BEHIND") verdict = "BEHIND";
    else if (
      state === "OPEN" &&
      pr.mergeStateStatus === "CLEAN" &&
      !reasons.length
    )
      verdict = "READY";
    for (const item of array(pr.statusCheckRollup ?? [])) {
      const check = object(item),
        result = String(check.conclusion || check.state || check.status);
      if (!["SUCCESS", "NEUTRAL", "SKIPPED"].includes(result))
        add(
          "FAILURE ERROR CANCELLED TIMED_OUT ACTION_REQUIRED STALE STARTUP_FAILURE"
            .split(" ")
            .includes(result)
            ? "CHECK_FAILED"
            : "CHECK_PENDING",
          String(check.name || check.context) + ": " + result,
        );
    }
    if (verdict === "DRAFT") add("DRAFT", "GitHub reports a draft");
    if (pr.mergeStateStatus !== "CLEAN")
      add("HOST_BLOCKED", pr.mergeStateStatus);
  } catch (error) {
    const text = message(error);
    if (text.startsWith("UNAVAILABLE:")) verdict = "UNAVAILABLE";
    add("HOST_BLOCKED", text);
  }
  return { head, state, verdict, reasons };
}
async function merge(call: Call) {
  const before = await status(call);
  const blocked = (text: string) => ({
    ...before,
    merged: false,
    verdict: "BLOCKED",
    reasons: [reason("HOST_BLOCKED", text)],
  });
  if (before.verdict !== "READY") return { ...before, merged: false };
  if (before.head !== call.input.expectHead)
    return blocked("Head does not match expectHead");
  const gh = client(call);
  try {
    await gh(
      [
        "pr",
        "merge",
        ...ref(call.input),
        "--squash",
        "--match-head-commit",
        call.input.expectHead,
      ],
      false,
    );
  } catch (error) {
    return blocked(message(error));
  }
  try {
    const after = object(await gh(view(call.input, "state,mergeCommit")));
    const commit = object(after.mergeCommit);
    if (after.state !== "MERGED" || typeof commit.oid !== "string")
      throw new Error("GitHub has not confirmed a merge commit");
    return { merged: true, mergeCommit: commit.oid };
  } catch (error) {
    return {
      ...before,
      merged: false,
      verdict: "UNAVAILABLE",
      reasons: [
        reason(
          "EVIDENCE_GAP",
          "Merge command succeeded but could not be confirmed: " +
            message(error),
        ),
      ],
    };
  }
}
type Gh = ReturnType<typeof client>;
/** Run one GitHub operation: a non-GitHub remote or missing gh is UNAVAILABLE, other failures BLOCKED. */
async function guarded<T extends object>(
  call: Call,
  empty: T,
  run: (gh: Gh, owner: string, name: string) => Promise<Partial<T>>,
) {
  const fail = (verdict: string, code: BlockerCode, text: string) => ({
    ...empty,
    verdict,
    reasons: [reason(code, text)],
  });
  if (!/^[\w.-]+\/[\w.-]+$/.test(call.input.repo))
    return fail(
      "UNAVAILABLE",
      "HOST_BLOCKED",
      "Only GitHub owner/repository references are supported",
    );
  try {
    const [owner, name] = call.input.repo.split("/");
    return {
      ...empty,
      verdict: "OK",
      reasons: [],
      ...(await run(client(call), owner!, name!)),
    };
  } catch (error) {
    const text = message(error);
    return fail(
      text.startsWith("UNAVAILABLE:") ? "UNAVAILABLE" : "BLOCKED",
      "HOST_BLOCKED",
      text,
    );
  }
}
const THREADS =
  "query($owner:String!,$name:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$endCursor){nodes{id isResolved path line comments(first:1){nodes{databaseId body author{login}}}} pageInfo{hasNextPage endCursor}}}}}";
const THREAD_STATE =
  "query($id:ID!){node(id:$id){... on PullRequestReviewThread{isResolved}}}";
const RESOLVE =
  "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}";
const threads = (call: Call) =>
  guarded(call, { threads: [] as unknown[] }, async (gh, owner, name) => {
    const pages = array(
      await gh([
        "api",
        "graphql",
        "--paginate",
        "--slurp",
        "-f",
        `query=${THREADS}`,
        "-f",
        `owner=${owner}`,
        "-f",
        `name=${name}`,
        "-F",
        `number=${call.input.number}`,
      ]),
    );
    if (!pages.length) throw new Error("Missing review threads");
    const limit = call.config.excerptChars ?? 200,
      found: unknown[] = [];
    for (const page of pages) {
      const data = object(page);
      if (data.errors) throw new Error("GitHub could not read review threads");
      const pull = object(object(object(data.data).repository).pullRequest);
      for (const node of array(object(pull.reviewThreads).nodes)) {
        const thread = object(node),
          first = object(array(object(thread.comments).nodes)[0]);
        if (
          typeof thread.id !== "string" ||
          typeof thread.isResolved !== "boolean" ||
          !Number.isInteger(first.databaseId) ||
          typeof first.body !== "string"
        )
          throw new Error("Invalid review thread");
        if (call.input.unresolved && thread.isResolved) continue;
        const author = first.author ? object(first.author).login : null;
        found.push({
          id: thread.id,
          commentId: first.databaseId,
          author: typeof author === "string" ? author : null,
          path: typeof thread.path === "string" ? thread.path : null,
          line: Number.isInteger(thread.line) ? thread.line : null,
          isResolved: thread.isResolved,
          excerpt: {
            kind: "untrusted",
            source: "github:review-comment",
            text: [...first.body].slice(0, limit).join(""),
          },
        });
      }
    }
    return { threads: found };
  });
const reply = (call: Call) =>
  guarded(call, { replyId: null as number | null }, async (gh) => {
    const created = object(
      await gh([
        "api",
        `repos/${call.input.repo}/pulls/${call.input.number}/comments/${call.input.commentId}/replies`,
        "-f",
        `body=${call.input.body}`,
      ]),
    );
    if (!Number.isInteger(created.id)) throw new Error("Invalid GitHub reply");
    return { replyId: created.id as number };
  });
const resolve = (call: Call) =>
  guarded(call, { isResolved: null as boolean | null }, async (gh) => {
    const id = `id=${call.input.threadId}`;
    await gh(["api", "graphql", "-f", `query=${RESOLVE}`, "-f", id]);
    let isResolved: unknown;
    try {
      const read = object(
        await gh(["api", "graphql", "-f", `query=${THREAD_STATE}`, "-f", id]),
      );
      isResolved = object(object(read.data).node).isResolved;
    } catch (error) {
      return {
        verdict: "UNAVAILABLE",
        reasons: [
          reason(
            "EVIDENCE_GAP",
            "Resolve succeeded but could not be confirmed: " + message(error),
          ),
        ],
      };
    }
    if (typeof isResolved !== "boolean")
      throw new Error("Invalid review thread state");
    return isResolved
      ? { isResolved }
      : {
          isResolved,
          verdict: "BLOCKED",
          reasons: [
            reason(
              "EVIDENCE_GAP",
              "GitHub does not report the thread resolved",
            ),
          ],
        };
  });
module.exports = {
  "pr.status": status,
  "pr.merge": merge,
  "pr.threads": threads,
  "pr.reply": reply,
  "pr.resolve": resolve,
};
