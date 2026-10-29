import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";

type Lane = { issue: string; worktree: string; branch: string; brief: string };
type Context = {
  common: string;
  root: string;
  load: () => Lane[];
  run: (
    command: string,
    args: string[],
    cwd?: string,
    env?: NodeJS.ProcessEnv,
  ) => string;
};
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function laneClose(argv: string[], ctx: Context): number {
  const issue = argv[0] ?? "";
  let pr = 0,
    receipt = "",
    mergeCommit = "";
  let status: "open" | "closed" = "open",
    stage = "input";
  let lock: string | undefined;
  const owner = `owner-${process.pid}-${randomUUID()}`;
  const reply = (ok: boolean, reason?: string) => {
    console.log(
      JSON.stringify({
        ok,
        issue,
        pr,
        mergeCommit,
        receipt,
        status,
        removed: ok,
        ...(reason
          ? {
              verdict: "refused",
              code: `${stage.toUpperCase()}_FAILED`,
              reasons: [reason],
              next: "correct the reason and rerun close with the same arguments",
            }
          : {}),
      }),
    );
    return ok ? 0 : stage === "input" ? 2 : 1;
  };
  try {
    const values = new Map<string, string>();
    let keepOpen = false;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(issue))
      throw new Error("invalid issue id");
    for (let i = 1; i < argv.length; i++) {
      const key = argv[i]!;
      if (key === "--keep-open" && !keepOpen) {
        keepOpen = true;
        continue;
      }
      const value = argv[++i];
      if (
        !["--pr", "--receipt"].includes(key) ||
        !value ||
        value.startsWith("--") ||
        values.has(key)
      )
        throw new Error("invalid, duplicate, or missing option");
      values.set(key, value);
    }
    pr = Number(values.get("--pr"));
    receipt = values.get("--receipt") ?? "";
    if (
      !/^[1-9]\d*$/.test(values.get("--pr") ?? "") ||
      !Number.isSafeInteger(pr) ||
      !receipt.trim()
    )
      throw new Error("close requires numeric --pr and --receipt");
    stage = "preflight";
    const lane = ctx.load().find((item) => item.issue === issue);
    if (!lane) throw new Error(`no active lane for ${issue}`);
    const journal = join(ctx.common, `forge-lane-close-${issue}.json`);
    const saved: unknown = existsSync(journal)
      ? JSON.parse(readFileSync(journal, "utf8"))
      : undefined;
    if (
      saved !== undefined &&
      (!object(saved) ||
        saved.pr !== pr ||
        saved.receipt !== receipt ||
        saved.keepOpen !== keepOpen ||
        saved.branch !== lane.branch ||
        saved.worktree !== lane.worktree ||
        typeof saved.head !== "string")
    )
      throw new Error(
        "pending close has different arguments; resume the original close",
      );
    const progress = object(saved) ? saved : undefined;
    const gh = (args: string[], token?: string) => {
      let command = "gh";
      if (process.platform === "win32") {
        const path =
          Object.entries(process.env).find(
            ([key]) => key.toLowerCase() === "path",
          )?.[1] ?? "";
        const shim = path
          .split(delimiter)
          .map((part) => join(part.replace(/^"|"$/g, ""), "gh"))
          .find(existsSync);
        if (shim) {
          command = "sh";
          args = [shim, ...args];
        }
      }
      const result = spawnSync(command, args, {
        cwd: ctx.root,
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
        env: { ...process.env, ...(token ? { GH_TOKEN: token } : {}) },
      });
      if (result.error || result.status !== 0)
        throw new Error(
          "gh command failed; check FORGE_GH_USER and authentication",
        );
      return result.stdout.trim();
    };
    if (!process.env.FORGE_GH_USER)
      throw new Error("FORGE_GH_USER is required");
    const token = gh(["auth", "token", "--user", process.env.FORGE_GH_USER]);
    if (!token) throw new Error("gh returned no authentication token");
    const pull: unknown = JSON.parse(
      gh(
        [
          "pr",
          "view",
          String(pr),
          "--json",
          "state,headRefName,headRefOid,mergeCommit,url",
        ],
        token,
      ),
    );
    if (
      !object(pull) ||
      pull.state !== "MERGED" ||
      !object(pull.mergeCommit) ||
      typeof pull.mergeCommit.oid !== "string" ||
      !/^[a-f0-9]{40}$/i.test(pull.mergeCommit.oid) ||
      typeof pull.url !== "string" ||
      !new RegExp(`^https://[^/\\s]+/[^/\\s]+/[^/\\s]+/pull/${pr}$`).test(
        pull.url,
      )
    )
      throw new Error("PR must be MERGED with a merge commit and URL");
    mergeCommit = pull.mergeCommit.oid;
    if (pull.headRefName !== lane.branch)
      throw new Error("PR head branch is not the lane branch");
    const git = (args: string[], cwd = ctx.root) => ctx.run("git", args, cwd);
    const ref = `refs/heads/${lane.branch}`;
    const hasBranch = git(["for-each-ref", "--format=%(refname)", ref])
      .split("\n")
      .includes(ref);
    const head = hasBranch ? git(["rev-parse", ref]) : progress?.head;
    if (typeof head !== "string" || head !== pull.headRefOid)
      throw new Error("PR head does not equal the local lane head");
    if (
      progress &&
      (progress.head !== head || progress.mergeCommit !== mergeCommit)
    )
      throw new Error("PR or local head changed since close began");
    if (existsSync(lane.worktree)) {
      if (
        git(["symbolic-ref", "--short", "HEAD"], lane.worktree) !==
          lane.branch ||
        git(["rev-parse", "HEAD"], lane.worktree) !== head
      )
        throw new Error("worktree is not at the lane head");
      if (
        git(["status", "--porcelain", "--untracked-files=all"], lane.worktree)
      )
        throw new Error("lane worktree has uncommitted or untracked changes");
    } else if (!progress)
      throw new Error("lane worktree is missing; cannot verify a clean lane");
    const forge = (
      noun: string,
      verb: string,
      input: Record<string, unknown>,
    ) => {
      const response: unknown = JSON.parse(
        ctx.run(
          "forge",
          [noun, verb, "--input", JSON.stringify(input)],
          ctx.root,
          { ...process.env, GH_TOKEN: token },
        ),
      );
      if (!object(response) || response.ok !== true)
        throw new Error(`forge ${noun} ${verb} failed`);
      return response.result;
    };
    const proof = forge("check", "show", { id: receipt });
    if (!object(proof) || proof.id !== receipt || proof.status !== "PASS")
      throw new Error("receipt must be PASS");
    if (proof.subject !== mergeCommit)
      throw new Error("receipt subject must equal the PR merge commit");
    if (
      !Array.isArray(proof.runs) ||
      !proof.runs.length ||
      proof.runs.some(
        (run: unknown) =>
          !object(run) || typeof run.name !== "string" || run.status !== "PASS",
      )
    )
      throw new Error("receipt must contain passing checks");
    const checks = proof.runs
      .map((run: Record<string, unknown>) => `${String(run.name)}: PASS`)
      .join(", ");
    const note = `PR #${pr} landed: ${pull.url}\nMerge commit: ${mergeCommit}\nReceipt: ${receipt}\nChecks: ${checks}`;
    const current = forge("issue", "show", { id: issue });
    const links = forge("issue", "links", { id: issue });
    const comments = forge("issue", "comments", { id: issue });
    if (
      !object(current) ||
      current.id !== issue ||
      !["open", "closed"].includes(String(current.status)) ||
      !object(links) ||
      !Array.isArray(links.records) ||
      !object(comments) ||
      !Array.isArray(comments.records)
    )
      throw new Error("cannot read issue status, links and comments");
    status = current.status as "open" | "closed";
    const linked = links.records.some(
      (record: unknown) =>
        object(record) &&
        object(record.value) &&
        record.value.relation === "delivers" &&
        record.value.url === pull.url,
    );
    if (
      (keepOpen && status !== "open") ||
      (!keepOpen &&
        status === "closed" &&
        (!linked || current.receipt !== receipt))
    )
      throw new Error("issue is already closed by a different landing");
    const commented = comments.records.some(
      (record: unknown) =>
        object(record) && object(record.value) && record.value.body === note,
    );
    // Publish a nonempty owner atomically, using start's registry lock protocol.
    const staged = join(ctx.common, `forge-lanes.lock.${randomUUID()}`);
    mkdirSync(staged);
    writeFileSync(join(staged, owner), "", { flag: "wx" });
    try {
      renameSync(staged, join(ctx.common, "forge-lanes.lock"));
    } catch {
      rmSync(staged, { recursive: true });
      throw new Error(
        "lane registry is locked; wait for the other lane operation",
      );
    }
    lock = join(ctx.common, "forge-lanes.lock");
    const latest = ctx.load().find((item) => item.issue === issue);
    if (
      !latest ||
      latest.branch !== lane.branch ||
      latest.worktree !== lane.worktree
    )
      throw new Error("lane record changed; inspect it before retrying");
    const state = {
      pr,
      receipt,
      keepOpen,
      branch: lane.branch,
      worktree: lane.worktree,
      head,
      mergeCommit,
      claimed: progress?.claimed === true,
    };
    const save = () => {
      const temp = `${journal}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(state));
      renameSync(temp, journal);
    };
    save();
    stage = "tracker";
    if (!keepOpen && status !== "closed") {
      if (!state.claimed) {
        forge("issue", "claim", { id: issue });
        state.claimed = true;
        save();
      }
      if (!linked)
        forge("issue", "link", {
          id: issue,
          relation: "delivers",
          url: pull.url,
        });
      forge("issue", "close", {
        id: issue,
        receipt,
        reason: `PR #${pr} merged as ${mergeCommit.slice(0, 7)}`,
      });
      const readback = forge("issue", "show", { id: issue });
      if (
        !object(readback) ||
        readback.id !== issue ||
        readback.status !== "closed"
      )
        throw new Error("issue close readback was not closed");
      status = "closed";
    }
    if (!commented) forge("issue", "comment", { id: issue, body: note });
    stage = "cleanup";
    if (
      (hasBranch && git(["rev-parse", ref]) !== head) ||
      (existsSync(lane.worktree) &&
        git(["rev-parse", "HEAD"], lane.worktree) !== head)
    )
      throw new Error("lane head changed during close; preserve the new work");
    if (existsSync(lane.worktree)) git(["worktree", "remove", lane.worktree]);
    if (hasBranch) git(["update-ref", "-d", ref, head]);
    const registry = join(ctx.common, "forge-lanes.json"),
      temp = `${registry}.${process.pid}.tmp`;
    writeFileSync(
      temp,
      `${JSON.stringify(
        ctx.load().filter((item) => item.issue !== issue),
        null,
        2,
      )}\n`,
    );
    renameSync(temp, registry);
    rmSync(journal);
    return reply(true);
  } catch (error) {
    return reply(
      false,
      error instanceof Error ? error.message : "lane close failed",
    );
  } finally {
    if (lock) {
      rmSync(join(lock, owner));
      rmdirSync(lock);
    }
  }
}
