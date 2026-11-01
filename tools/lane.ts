// Repository helper: bun tools/lane.ts start <issue> --branch <name> --brief <file> [--max N]
// Markdown scanning adapted from cursor/plugins pstack check-plan.mjs:
// https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/scripts/check-plan.mjs
// MIT License, Copyright (c) 2026 Lauren Tan
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { interruptLaneRuns, laneHistory, laneRun } from "./lane-run.ts";
import { laneTier } from "./lane-tier.ts";
import { laneClose } from "./lane-close.ts";
import { runCommand } from "./run-command.ts";

type Lane = { issue: string; worktree: string; branch: string; brief: string };
type Options = { issue: string; branch: string; brief: string; max: number };
const required = [
  "Goal",
  "Acceptance test",
  "Files",
  "Forbidden actions",
  "Stop point",
  "Prior art",
];
const pause = new Int32Array(new SharedArrayBuffer(4));
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function run(
  command: string,
  args: string[],
  cwd = process.cwd(),
  env = process.env,
) {
  const failure =
    command === "gh"
      ? "gh command failed; check FORGE_GH_USER and authentication"
      : `${command} command failed`;
  const result = runCommand(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
    env,
  });
  if (result.error || result.status !== 0) throw new Error(failure);
  return result.stdout.trim();
}
function briefProblems(text: string): string[] {
  const lines = text
    .replace(/^\uFEFF/, "")
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .split(/\r?\n/);
  let start = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end < 0) return ["brief frontmatter is not closed"];
    start = end + 1;
  }
  const bodies = new Map<string, string[]>();
  let current: string | undefined;
  let fence: { char: string; length: number } | undefined;
  for (const line of lines.slice(start)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (
        marker &&
        marker[1]![0] === fence.char &&
        marker[1]!.length >= fence.length &&
        marker[2]!.trim() === ""
      )
        fence = undefined;
      else if (current) bodies.get(current)?.push(line);
      continue;
    }
    if (marker && !(marker[1]![0] === "`" && marker[2]!.includes("`"))) {
      fence = { char: marker[1]![0]!, length: marker[1]!.length };
      continue;
    }
    const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading && heading[1]!.length <= 2) {
      current = heading[1] === "##" ? heading[2] : undefined;
      if (current && !bodies.has(current)) bodies.set(current, []);
    } else if (current) bodies.get(current)?.push(line);
  }
  return required
    .filter(
      (name) => !bodies.get(name)?.some((line) => /[\p{L}\p{N}]/u.test(line)),
    )
    .map((name) => `brief requires non-empty section: ${name}`);
}
function options(
  argv: string[],
): Options | "list" | "run" | "auto" | "tier" | "close" {
  if (argv[0] === "close") return "close";
  if (argv[0] === "run") return "run";
  if (argv[0] === "auto") return "auto";
  if (
    argv[0] === "tier" &&
    argv.length === 2 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(argv[1]!) &&
    argv[1] !== "." &&
    argv[1] !== ".."
  )
    return "tier";
  if (argv.length === 1 && argv[0] === "list") return "list";
  const [verb, issue, ...flags] = argv;
  if (
    verb !== "start" ||
    !issue ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(issue) ||
    issue === "." ||
    issue === ".."
  )
    throw new Error(
      "usage: start <issue-id> --branch <name> --brief <file> [--max N], tier <issue-id>, list, or close <issue-id> --pr N (--receipt <id> [--keep-open] | --dropped <reason>) [--discard-ignored]",
    );
  const values = new Map<string, string>();
  for (let i = 0; i < flags.length; i += 2) {
    const key = flags[i]!,
      value = flags[i + 1];
    if (
      !["--branch", "--brief", "--max"].includes(key) ||
      !value ||
      values.has(key)
    )
      throw new Error("invalid, duplicate, or missing option");
    values.set(key, value);
  }
  const branch = values.get("--branch"),
    brief = values.get("--brief"),
    cap = values.get("--max") ?? "3";
  if (
    !branch ||
    !brief ||
    !/^[1-9]\d*$/.test(cap) ||
    !Number.isSafeInteger(Number(cap))
  )
    throw new Error("branch, brief, and a positive integer max are required");
  try {
    run("git", ["check-ref-format", "--branch", branch]);
  } catch {
    throw new Error("invalid branch name");
  }
  return { issue, branch, brief: resolve(brief), max: Number(cap) };
}
function load(file: string): Lane[] {
  if (!existsSync(file)) return [];
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (
    !Array.isArray(value) ||
    !value.every(
      (item: unknown) =>
        object(item) &&
        ["issue", "worktree", "branch", "brief"].every(
          (key) => typeof item[key] === "string",
        ),
    )
  )
    throw new Error(
      "lane registry is invalid; repair it before starting a lane",
    );
  return value as Lane[];
}
function active(file: string, root: string): Lane[] {
  const registered = new Set(
    run("git", ["worktree", "list", "--porcelain", "-z"], root)
      .split("\0")
      .filter((part) => part.startsWith("worktree "))
      .map((part) => resolve(part.slice(9))),
  );
  return load(file).filter(
    (lane) => existsSync(lane.worktree) && registered.has(lane.worktree),
  );
}
function removeEmpty(lock: string): void {
  try {
    rmdirSync(lock);
  } catch (error) {
    if (
      !object(error) ||
      !["ENOENT", "ENOTEMPTY", "EEXIST"].includes(String(error.code))
    )
      throw error;
  }
}
function release(lock: string, owner: string): void {
  // Unlink only this generation's owner, then refuse to remove a nonempty replacement.
  unlinkSync(join(lock, owner));
  removeEmpty(lock);
}
function reclaim(lock: string): void {
  try {
    const owners = readdirSync(lock);
    // Atomic publication is nonempty; empty locks can only be abandoned cleanup.
    if (owners.length === 0) return removeEmpty(lock);
    const owner = owners.length === 1 ? owners[0] : undefined;
    const match = owner?.match(
      /^owner-([1-9]\d*)-[0-9a-f-]{36}(?:-([1-9]\d*))?$/,
    );
    if (!match) return;
    try {
      process.kill(Number(match[1]), 0);
      return;
    } catch (error) {
      if (!object(error) || error.code !== "ESRCH") return;
    }
    try {
      if (match[2] && process.kill(Number(match[2]), 0)) return;
    } catch (error) {
      if (!object(error) || error.code !== "ESRCH") return;
    }
    release(lock, owner!);
  } catch (error) {
    if (!object(error) || error.code !== "ENOENT") throw error;
  }
}
function acquireLaneLock(common: string, id: string, owner: string) {
  const lock = join(common, `forge-lane-${id}.lock`),
    staged = `${lock}.${randomUUID()}`,
    prior = join(lock, `${inheritedOwner}-${process.pid}`);
  if (inheritedOwner && existsSync(prior)) {
    renameSync(prior, join(lock, owner));
  } else {
    mkdirSync(staged);
    writeFileSync(join(staged, owner), "", { flag: "wx" });
    try {
      reclaim(lock);
      renameSync(staged, lock);
    } catch {
      release(staged, owner);
      throw new Error("lane already running; wait for it to finish and retry");
    }
  }
  let current = owner;
  return (pid?: number) => {
    if (!pid) return release(lock, current);
    const next = `${owner}-${pid}`;
    renameSync(join(lock, current), join(lock, next));
    current = next;
  };
}

type HistoryRun = ReturnType<typeof laneHistory>[number];
function stepVerdict(record: HistoryRun): string {
  if (record.role === "unknown") return "unknown";
  if (record.verdict !== "completed") return record.verdict;
  if (!["tester", "reviewer"].includes(record.role)) return record.verdict;
  let first = "";
  try {
    first = readFileSync(record.reply, "utf8").split(/\r?\n/)[0] ?? "";
  } catch {
    /* Missing reports fail closed. */
  }
  const pass = record.role === "tester" ? "PASS" : "CLEAN";
  return first === `Verdict: ${pass}`
    ? pass
    : record.role === "tester"
      ? "FAIL"
      : "ACT";
}
async function laneAuto(
  argv: string[],
  context: Parameters<typeof laneRun>[1],
) {
  let step = "builder";
  let unlock: ((pid?: number) => void) | undefined;
  const emit = (value: object) => console.log(JSON.stringify(value));
  const blocked = (reason: string, next: string) => {
    emit({ outcome: "blocked", reason, step, next });
    return 1;
  };
  try {
    const detach = argv.includes("--detach"),
      args = argv.filter((arg) => arg !== "--detach");
    const [id, flag, capText = "2", ...extra] = args;
    if (
      !id ||
      extra.length ||
      argv.length - args.length > 1 ||
      (flag && (flag !== "--round-cap" || args.length !== 3)) ||
      !/^(?:[1-9]|10)$/.test(capText)
    )
      return blocked(
        "refused",
        "usage: auto <issue-id> [--round-cap 1..10] [--detach]",
      );
    const cap = Number(capText),
      lane = context.lanes.find((item) => item.issue === id);
    if (!lane)
      return blocked("refused", `no active lane for ${id}; use start first`);
    unlock = context.lock(id);
    if (detach) {
      const root = join(context.common, "forge-lane-runs", id),
        stamp = new Date().toISOString().replaceAll(":", "-");
      mkdirSync(root, { recursive: true });
      const log = join(root, `auto-${stamp}.log`),
        output = openSync(log, "wx");
      try {
        const child = spawn(
          process.execPath,
          [import.meta.filename, "auto", ...args],
          {
            cwd: process.cwd(),
            detached: true,
            windowsHide: true,
            stdio: ["ignore", output, output],
            env: { ...process.env, FORGE_LANE_LOCK_OWNER: laneOwner },
          },
        );
        await once(child, "spawn");
        unlock(child.pid);
        unlock = undefined;
        child.unref();
        emit({
          outcome: "detached",
          pid: child.pid,
          log,
          next: "bun tools/lane.ts list",
        });
        return 0;
      } finally {
        closeSync(output);
      }
    }
    interruptLaneRuns(context.common, id);
    for (;;) {
      const history = laneHistory(context.common, id);
      if (history.some((record) => record.role === "unknown"))
        throw new Error("inspect unknown lane history before resuming");
      const runs = history.filter((record) => record.role !== "unknown");
      const pending = runs.at(-1),
        retry = pending?.verdict === "interrupted";
      const records = runs.filter((record) => record.verdict !== "interrupted");
      const last = records.at(-1),
        head = run("git", ["rev-parse", "HEAD"], lane.worktree);
      if (last && !retry && last.verdict !== "completed") {
        step = last.role;
        return blocked(
          "failed",
          "inspect the failed/unfinished run; use run --resume if possible",
        );
      }
      const rounds = records.filter(
        (record) => record.role === "tester" && record.verdict === "completed",
      ).length;
      const previous = records.at(-2),
        reviewer = records.at(-3);
      const repair =
        previous?.role === "fixer" &&
        (previous.completionHead ?? previous.head) === head &&
        reviewer?.role === "reviewer" &&
        stepVerdict(reviewer) === "ACT";
      const changed = run(
        "git",
        ["rev-list", "--count", "origin/main..HEAD"],
        lane.worktree,
      );
      const built = changed !== "0";
      const completedBuild = records.findLast(
        (record) =>
          record.verdict === "completed" &&
          ["builder", "fixer"].includes(record.role),
      );
      if (!retry && !built && completedBuild) {
        step = completedBuild.role;
        return blocked("no-commit", "commit the lane changes, then retry");
      }
      step = built ? "tester" : "builder";
      if (
        built &&
        last?.head === head &&
        last.role === "reviewer" &&
        previous?.head === head &&
        previous.role === "tester" &&
        stepVerdict(previous) === "PASS"
      ) {
        if (stepVerdict(last) === "CLEAN") step = "ready";
        else step = "fixer";
      } else if (built && last?.head === head && last.role === "tester") {
        if (stepVerdict(last) === "PASS")
          step =
            repair || !laneTier(lane.worktree).reviews.includes("reviewer")
              ? "ready"
              : "reviewer";
        else {
          if (repair)
            return blocked(
              "failed",
              "review repair failed; inspect the report and simplify or park",
            );
          step = "fixer";
        }
      }
      if (retry) step = pending!.role;
      if (step === "ready") {
        if (laneTier(lane.worktree).reviews.includes("security-reviewer"))
          return blocked(
            "security-review",
            "run the security review, then push",
          );
        if (run("git", ["status", "--porcelain"], lane.worktree))
          return blocked(
            "dirty-worktree",
            "commit or remove the worktree changes, then retry",
          );
        emit({ outcome: "ready", head, next: "push and open the PR" });
        return 0;
      }
      if (
        (step === "tester" || (step === "fixer" && last?.role === "tester")) &&
        rounds >= cap
      ) {
        step = "tester";
        return blocked(
          "round-cap",
          `Test round ${rounds + 1} exceeds the cap (${cap}). Write a three-line threat model, then choose ship, simplify or park.`,
        );
      }
      let report: Record<string, unknown> = {};
      const start = Date.now();
      const code = await laneRun(
        [id, "--role", step, "--round-cap", String(cap)],
        {
          ...context,
          lock: () => (pid) => {
            if (pid) unlock!(pid);
          },
          auto: true,
          ...(step === "fixer" && last ? { fixReport: last.reply } : {}),
          report: (json) => {
            report = JSON.parse(json) as Record<string, unknown>;
          },
        },
      );
      const finished = laneHistory(context.common, id)
        .filter((record) => record.role !== "unknown")
        .at(-1);
      emit({
        step,
        round: step === "tester" ? rounds + 1 : null,
        verdict:
          code === 0 && finished ? stepVerdict(finished) : report.verdict,
        reply: report.reply ?? null,
        minutes: (Date.now() - start) / 60_000,
      });
      if (code !== 0)
        return blocked(
          report.exit === 124 ||
            /timeout|timed out/i.test(JSON.stringify(report))
            ? "timeout"
            : report.verdict === "refused"
              ? "refused"
              : "failed",
          typeof report.next === "string" ? report.next : "inspect the run log",
        );
    }
  } catch (error) {
    return blocked(
      "refused",
      error instanceof Error ? error.message : "inspect lane history and retry",
    );
  } finally {
    unlock?.();
  }
}
const laneOwner = `owner-${process.pid}-${randomUUID()}`;
const inheritedOwner = process.env.FORGE_LANE_LOCK_OWNER;
delete process.env.FORGE_LANE_LOCK_OWNER;
async function main(): Promise<number> {
  let parsed: Options | "list" | "run" | "auto" | "tier" | "close";
  let target: string | null = null;
  const reply = (
    reason: string | string[],
    code = 1,
    next = "correct the reasons and retry",
  ) => {
    console.log(
      JSON.stringify({
        verdict: "refused",
        reasons: typeof reason === "string" ? [reason] : reason,
        worktree: target,
        branch: typeof parsed === "object" ? parsed.branch : null,
        brief: typeof parsed === "object" ? parsed.brief : null,
        next,
      }),
    );
    return code;
  };
  try {
    parsed = options(process.argv.slice(2));
  } catch (error) {
    return reply(error instanceof Error ? error.message : "invalid input", 2);
  }
  let lock: string | undefined;
  let staged: string | undefined;
  const owner = laneOwner;
  let held = false;
  try {
    const context = () => {
      const common = resolve(
        run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      );
      const root = resolve(
        run("git", [
          "--git-dir",
          common,
          "worktree",
          "list",
          "--porcelain",
          "-z",
        ])
          .split("\0")[0]!
          .slice(9),
      );
      return {
        common,
        root,
        load: () => load(join(common, "forge-lanes.json")),
        run,
        lock: (id: string) => acquireLaneLock(common, id, owner),
      };
    };
    if (parsed === "close") return laneClose(process.argv.slice(3), context);
    const { common, root, lock: lockLane } = context();
    const registry = join(common, "forge-lanes.json");
    if (parsed === "tier") {
      const lane = active(registry, root).find(
        (item) => item.issue === process.argv[3],
      );
      if (!lane)
        throw new Error(
          `no active lane for ${process.argv[3]}; use start first`,
        );
      console.log(JSON.stringify(laneTier(lane.worktree)));
      return 0;
    }
    if (parsed === "run" || parsed === "auto") {
      const execute = parsed === "auto" ? laneAuto : laneRun;
      return await execute(process.argv.slice(3), {
        common,
        configRoot: resolve(run("git", ["rev-parse", "--show-toplevel"])),
        lanes: active(registry, root),
        issue: (id) =>
          run("forge", ["issue", "show", "--input", JSON.stringify({ id })]),
        lock: lockLane,
      });
    }
    if (parsed === "list") {
      console.log(
        JSON.stringify({
          lanes: active(registry, root).map((lane) => {
            let unlock: (() => void) | undefined;
            try {
              unlock = lockLane(lane.issue);
            } catch {
              /* A live lane stays untouched. */
            }
            if (unlock) {
              try {
                interruptLaneRuns(common, lane.issue);
              } finally {
                unlock();
              }
            }
            const runs = laneHistory(common, lane.issue),
              last = runs.at(-1);
            return {
              ...lane,
              runs,
              state: last ? `${last.role} ${stepVerdict(last)}` : null,
              since: last && last.role !== "unknown" ? last.end : null,
            };
          }),
        }),
      );
      return 0;
    }
    const worktree = join(root, ".worktrees", parsed.issue);
    target = worktree;
    const problems = briefProblems(readFileSync(parsed.brief, "utf8"));
    if (problems.length)
      return reply(problems, 1, "fill the named required sections and retry");
    const issue: unknown = JSON.parse(
      run(
        "forge",
        ["issue", "show", "--input", JSON.stringify({ id: parsed.issue })],
        root,
      ),
    );
    if (
      !object(issue) ||
      issue.ok !== true ||
      !object(issue.result) ||
      issue.result.id !== parsed.issue
    )
      return reply(
        "forge issue show did not return the requested issue successfully",
      );
    lock = join(common, "forge-lanes.lock");
    const pending = `${lock}.${process.pid}.${randomUUID()}`;
    mkdirSync(pending);
    writeFileSync(join(pending, owner), "", { flag: "wx" });
    staged = pending;
    const deadline = Date.now() + 15_000;
    while (!held) {
      try {
        // Publish the owner and directory together; an existing live lock is nonempty.
        if (existsSync(lock)) {
          reclaim(lock);
          if (existsSync(lock))
            throw Object.assign(new Error("locked"), { code: "EEXIST" });
        }
        renameSync(staged, lock);
        held = true;
      } catch (error) {
        if (
          !object(error) ||
          !["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(
            String(error.code),
          )
        )
          throw error;
        if (Date.now() >= deadline)
          return reply(
            `lane registry is locked; next: wait for a lane to finish or inspect ${lock}`,
            1,
            `wait for a lane to finish or inspect ${lock}`,
          );
        Atomics.wait(pause, 0, 0, 50);
      }
    }
    const lanes = active(registry, root);
    if (lanes.length >= parsed.max)
      return reply(
        `${lanes.length + 1} lanes, cap ${parsed.max}; next: wait for a lane to finish or remove one`,
        1,
        "wait for a lane to finish or remove one",
      );
    run("git", ["fetch", "origin", "main"], root);
    mkdirSync(join(root, ".worktrees"), { recursive: true });
    run(
      "git",
      ["worktree", "add", "-b", parsed.branch, worktree, "origin/main"],
      root,
    );
    const lane: Lane = {
      issue: parsed.issue,
      worktree,
      branch: parsed.branch,
      brief: parsed.brief,
    };
    const temp = `${registry}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify([...lanes, lane], null, 2)}\n`, {
        flag: "wx",
      });
      renameSync(temp, registry);
    } catch (error) {
      rmSync(temp, { force: true });
      run("git", ["worktree", "remove", worktree], root);
      run("git", ["branch", "-d", parsed.branch], root);
      throw error;
    }
    console.log(
      JSON.stringify({
        verdict: "started",
        reasons: [],
        worktree,
        branch: parsed.branch,
        brief: parsed.brief,
        next: `work in ${worktree}`,
      }),
    );
    return 0;
  } catch (error) {
    return reply(error instanceof Error ? error.message : "lane start failed");
  } finally {
    if (held && lock) release(lock, owner);
    else if (staged) release(staged, owner);
  }
}
process.exitCode = await main();
