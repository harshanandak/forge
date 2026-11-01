import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { runCommand } from "./run-command.ts";

type Pull = {
  number: number;
  title: string;
  url: string;
  mergeCommit?: { oid: string };
  mergedAt?: string;
  mergeable?: string;
  mergeStateStatus?: string;
  reviewDecision?: string;
  reviewThreads: Page<{ isResolved: boolean }>;
};
type Page<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean } };
type Response = {
  errors?: unknown[];
  data: { repository: { pullRequests: Page<Pull> } };
};
type Lane = {
  issue: string;
  state?: string;
  since?: string;
  runs: {
    start: string;
    end: string | null;
    role: string;
    verdict: string;
    reply?: string;
  }[];
};
type Issue = { id: string; title: string; createdAt: string };
const query = `query($owner:String!,$repo:String!,$endCursor:String){repository(owner:$owner,name:$repo){pullRequests(states:OPEN,first:100,after:$endCursor){nodes{number title url mergeable mergeStateStatus reviewDecision reviewThreads(first:100){nodes{isResolved} pageInfo{hasNextPage}}} pageInfo{hasNextPage endCursor}}}}`;
let token = "";
function command(program: string, args: string[]): string {
  const r = runCommand(program, args, {
    env: { ...process.env, ...(token ? { GH_TOKEN: token } : {}) },
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  const checks = args[1] === "checks";
  if (checks && !r.error && r.status === 1) {
    if (/^no required checks\b/i.test(r.stderr.trim())) return "[]";
    if (/^no checks reported\b/i.test(r.stderr.trim()))
      return '[{"name":"checks","bucket":"pending"}]';
  }
  const accepted = checks ? [0, 1, 8] : [0];
  if (r.error || !accepted.includes(r.status ?? -1))
    throw new Error("Read failed");
  return r.stdout.trim();
}
const gh = <T>(words: string, ...args: string[]): T =>
  JSON.parse(command("gh", [...words.split(" "), ...args])) as T;
const usage =
  "Usage: bun tools/digest.ts [--since <iso>] [--stall-hours <finite nonnegative number>] [--peek] [--json]";
let invalidThreshold = false;
try {
  const startedAt = new Date().toISOString();
  const { values: flags } = parseArgs({
    options: {
      since: { type: "string" },
      "stall-hours": { type: "string", default: "2" },
      peek: { type: "boolean" },
      json: { type: "boolean" },
    },
  });
  const hours = Number(flags["stall-hours"]);
  invalidThreshold =
    !flags["stall-hours"]?.trim() || !Number.isFinite(hours) || hours < 0;
  if (invalidThreshold) throw new Error("Invalid threshold");
  const common = resolve(command("git", ["rev-parse", "--git-common-dir"]));
  const marker = join(common, "forge-digest.json");
  const saved =
    !flags.since && existsSync(marker) ? readFileSync(marker, "utf8") : "{}";
  const previous = (JSON.parse(saved) as { lastSeen?: string }).lastSeen;
  const since =
    flags.since ??
    previous ??
    new Date(Date.parse(startedAt) - 86400_000).toISOString();
  if (isNaN(Date.parse(since))) throw new Error("Invalid window");
  const errors: { source: string; next: string }[] = [];
  function source<T>(name: string, read: () => T[]): T[] {
    try {
      return read();
    } catch {
      errors.push({
        source: name,
        next: `check ${name} availability, authentication and completeness; rerun with --peek`,
      });
      return [];
    }
  }
  source("gh authentication", () => {
    const user = process.env.FORGE_GH_USER;
    if (user) token = command("gh", ["auth", "token", "--user", user]);
    if (process.env.FORGE_GH_USER && !token) throw new Error("Empty token");
    return [];
  });
  const merged = source("gh merged PRs", () => {
    const rows = gh<Pull[]>(
      "pr list --state=merged --limit=1000",
      "--search",
      `merged:>=${new Date(since).toISOString()}`,
      "--json=number,title,mergeCommit,url,mergedAt",
    );
    if (rows.length >= 1000) throw new Error("Incomplete merges");
    return rows.filter((row) => Date.parse(row.mergedAt!) >= Date.parse(since));
  });
  const blocked = source("gh open PRs", () => {
    const { nameWithOwner } = gh<{ nameWithOwner: string }>(
      "repo view --json=nameWithOwner",
    );
    const [owner, repo] = nameWithOwner.split("/");
    const pages = gh<Response[]>(
      "api graphql --paginate --slurp",
      "-f",
      `query=${query}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `repo=${repo}`,
    );
    return pages.flatMap((page) => {
      if (page.errors?.length) throw new Error("Incomplete PRs");
      return page.data.repository.pullRequests.nodes.flatMap((pr) =>
        source(`gh PR #${pr.number}`, () => {
          if (pr.reviewThreads.pageInfo.hasNextPage)
            throw new Error("Incomplete threads");
          const checks = gh<{ name: string; bucket: string }[]>(
            "pr checks --required --json=name,bucket,link",
            String(pr.number),
          );
          const reasons = checks
            .filter((c) => ["fail", "pending", "cancel"].includes(c.bucket))
            .map((c) => `${c.name} ${c.bucket}`);
          if (pr.mergeable === "CONFLICTING") reasons.push("merge conflicts");
          if (pr.reviewThreads.nodes.some((t) => !t.isResolved))
            reasons.push("unresolved review threads");
          if (pr.reviewDecision === "CHANGES_REQUESTED")
            reasons.push("changes requested");
          if (pr.mergeStateStatus === "BEHIND")
            reasons.push("stale head: CI on an old base");
          if (pr.mergeable === "UNKNOWN") reasons.push("mergeability pending");
          return reasons.length ? [{ ...pr, reasons }] : [];
        }),
      );
    });
  });
  const issues = source("forge issue list", () => {
    const raw = command("forge", [
      "issue",
      "list",
      "--input",
      '{"limit":1000}',
    ]);
    const r = JSON.parse(raw) as {
      ok: boolean;
      result: { items: Issue[]; truncated?: boolean };
    };
    const incomplete = r.result.truncated || r.result.items.length >= 1000;
    if (!r.ok || incomplete) throw new Error("Incomplete issues");
    return r.result.items.filter(
      (issue) => Date.parse(issue.createdAt) >= Date.parse(since),
    );
  });
  const stalled = source("lanes", () => {
    const { lanes } = JSON.parse(
      command(process.execPath, [join(import.meta.dirname, "lane.ts"), "list"]),
    ) as { lanes: Lane[] };
    return lanes.flatMap((lane) => {
      const runs = lane.runs
        .filter((r) => r.start)
        .sort((a, b) => b.start.localeCompare(a.start));
      if (runs.some((r) => r.end === null) || lane.state === "running")
        return [];
      const last = runs[0],
        end = lane.state && lane.since ? lane.since : last?.end;
      const idleHours =
        (Date.parse(startedAt) - Date.parse(end ?? "")) / 3600_000;
      const verdict =
        last?.reply && existsSync(last.reply)
          ? (readFileSync(last.reply, "utf8")
              .match(/^Verdict: .+$/m)?.[0]
              .trimEnd() ?? last.verdict)
          : last?.verdict;
      const reason = `idle ${Math.floor(idleHours)} h${last ? ` after ${last.role} ${verdict}` : ""}`;
      return idleHours > hours
        ? [{ issue: lane.issue, idleHours, reason }]
        : [];
    });
  });
  const decisions = [
    ...blocked.map(
      (pr) =>
        `PR #${pr.number} ${pr.url}: ${pr.reasons.join(", ")}: (a) ask lane to resolve [default] (b) park`,
    ),
    ...stalled.map(
      (l) =>
        `lane ${l.issue} ${l.reason}: (a) run the fixer [default] (b) park`,
    ),
  ];
  if (!errors.length && !flags.peek)
    source("marker", () => {
      writeFileSync(marker, JSON.stringify({ lastSeen: startedAt }) + "\n");
      return [];
    });
  const result = { decisions, merged, blocked, stalled, issues, errors };
  const list = (rows: string[]) => rows.join("\n");
  const text = `Decisions needed:${decisions.length ? "\n" + list(decisions) : " none"}
Merged:
${list(merged.map((p) => `PR #${p.number} ${p.title} ${p.mergeCommit?.oid} ${p.url}`))}
Blocked:
${list(blocked.map((p) => `PR #${p.number} ${p.title} ${p.url}: ${p.reasons.join(", ")}`))}
Stalled lanes:
${list(stalled.map((l) => `lane ${l.issue} ${l.reason}`))}
Issues filed:
${list(issues.map((i) => `${i.id} ${i.title}`))}
${list(errors.map((e) => `Source failed: ${e.source}; next: ${e.next}`))}`;
  const output = flags.json
    ? JSON.stringify(result)
    : text.replaceAll("—", ":");
  console.log(token ? output.replaceAll(token, "[redacted]") : output);
  process.exitCode = errors.length ? 1 : 0;
} catch (error) {
  const invalidArguments =
    invalidThreshold ||
    (error instanceof Error &&
      "code" in error &&
      typeof error.code === "string" &&
      error.code.startsWith("ERR_PARSE_ARGS_") &&
      error.message.includes("--stall-hours"));
  const next = invalidArguments
    ? usage
    : "check arguments and git common dir marker";
  console.log(
    process.argv.includes("--json")
      ? JSON.stringify({ errors: [{ source: "configuration", next }] })
      : invalidArguments
        ? `Decisions needed: none\n${usage}`
        : `Decisions needed: none\nSource failed: configuration; next: ${next}`,
  );
  process.exitCode = invalidArguments ? 2 : 1;
}
