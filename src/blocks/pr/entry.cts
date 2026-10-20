import type { HandlerArgs } from "../../contract/author.ts";
import type { ProcessPort } from "../../ports/process.ts";
import type { BlockerCode } from "./contract.ts";
type Input = { repo: string; number: number; expectHead?: string };
type Services = {
  process: ProcessPort;
  files: { root: string };
  environment: {
    select(names: readonly string[]): Readonly<Record<string, string>>;
  };
};
type Call = HandlerArgs<Input, { requireResolvedThreads?: boolean }, Services>;
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
    "PATH PATHEXT SystemRoot HOME USERPROFILE GH_TOKEN GITHUB_TOKEN GH_CONFIG_DIR".split(
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
      "query($owner:String!,$name:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$endCursor){nodes{isResolved} pageInfo{hasNextPage endCursor}}}}}";
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
    let unresolved = 0;
    for (const page of pages) {
      const data = object(page);
      if (data.errors) throw new Error("GitHub could not read review threads");
      const threads = object(
        object(object(object(data.data).repository).pullRequest).reviewThreads,
      );
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
    if (state === "MERGED" || state === "CLOSED") verdict = state;
    else if (pr.isDraft) verdict = "DRAFT";
    else if (pr.mergeStateStatus === "BEHIND") verdict = "BEHIND";
    else if (
      state === "OPEN" &&
      pr.mergeStateStatus === "CLEAN" &&
      !reasons.length
    )
      verdict = "READY";
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
  try {
    const gh = client(call);
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
    const after = object(await gh(view(call.input, "state,mergeCommit")));
    const commit = object(after.mergeCommit);
    if (after.state !== "MERGED" || typeof commit.oid !== "string")
      throw new Error("GitHub has not confirmed a merge commit");
    return { merged: true, mergeCommit: commit.oid };
  } catch (error) {
    return blocked(message(error));
  }
}
module.exports = { "pr.status": status, "pr.merge": merge };
