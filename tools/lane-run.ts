import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export type RunOptions = {
  worktree: string;
  folder: string;
  model: string;
  effort: string;
  prompt: string;
  resume?: string;
  readOnly?: boolean;
  started?: (pid: number) => void;
};
export async function runCodex(
  options: RunOptions,
  timing = {
    replyGraceMs: 90_000,
    pollMs: 1_000,
    retryDelayMs: 60_000,
  },
) {
  const { worktree, folder, model, effort } = options;
  mkdirSync(folder, { recursive: true });
  const reply = join(folder, "reply.md"),
    log = join(folder, "log.txt");
  if (existsSync(reply))
    throw new Error("reply already exists; use a fresh run folder");
  writeFileSync(join(folder, "start.txt"), new Date().toISOString() + "\n");
  let session = options.resume ?? null,
    retries = 0,
    stoppedAfterReply = false;
  let exit: number | null;
  const controller = new AbortController(),
    signals = ["SIGINT", "SIGTERM"] as const;
  let stop = () => {};
  const interrupt = () => {
    controller.abort();
    stop();
  };
  for (const signal of signals) process.on(signal, interrupt);
  try {
    for (;;) {
      const offset = retries ? readFileSync(log, "utf8").length : 0;
      const args = [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "-m",
        model,
        "-c",
        `model_reasoning_effort=${JSON.stringify(effort)}`,
        "-c",
        `service_tier=${JSON.stringify(retries ? "default" : "priority")}`,
        "-o",
        reply,
      ];
      if (options.readOnly) args.push("-c", 'sandbox_mode="read-only"');
      else args.push("--dangerously-bypass-approvals-and-sandbox");
      if (session) args.push("resume", session);
      args.push("-");
      let command = "codex";
      if (process.platform === "win32") {
        const path =
          Object.entries(process.env).find(
            ([key]) => key.toLowerCase() === "path",
          )?.[1] ?? "";
        const shim = path
          .split(delimiter)
          .map((part) => join(part.replace(/^"|"$/g, ""), "codex"))
          .find(existsSync);
        if (!shim)
          throw new Error(
            "codex shell shim not found on PATH; install Codex CLI",
          );
        args.unshift(shim);
        command = "sh";
      }
      const output = openSync(log, retries ? "a" : "w");
      const promptPath = join(folder, retries ? "continue.txt" : "brief.md");
      writeFileSync(
        promptPath,
        retries
          ? "Continue the same task after the capacity error. All original rules and the final reply format still apply.\n"
          : options.prompt,
      );
      const promptFile = openSync(promptPath, "r");
      let seen: number | undefined;
      let timer: ReturnType<typeof setInterval> | undefined;
      try {
        exit = await new Promise<number | null>((done, fail) => {
          const child = spawn(command, args, {
            cwd: worktree,
            stdio: [promptFile, output, output],
            windowsHide: true,
            detached: true,
          });
          stop = () => {
            if (child.exitCode !== null || child.signalCode !== null) return;
            if (process.platform === "win32")
              spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
                windowsHide: true,
                stdio: "ignore",
                timeout: 10_000,
              });
            else if (child.pid) process.kill(-child.pid, "SIGKILL");
          };
          child.once("error", fail);
          child.once("close", done);
          try {
            if (child.pid) options.started?.(child.pid);
          } catch {
            interrupt();
          }
          timer = setInterval(() => {
            if (seen === undefined && existsSync(reply)) seen = Date.now();
            if (
              seen !== undefined &&
              Date.now() - seen >= timing.replyGraceMs &&
              child.exitCode === null
            ) {
              stoppedAfterReply = true;
              stop();
            }
          }, timing.pollMs);
        });
      } finally {
        clearInterval(timer);
        stop = () => {};
        closeSync(promptFile);
        closeSync(output);
      }
      if (controller.signal.aborted) throw new Error("lane run interrupted");
      const text = readFileSync(log, "utf8").slice(offset);
      session ??=
        text.match(
          /"type"\s*:\s*"thread.started"[^\n]*?"thread_id"\s*:\s*"([^"]+)"/,
        )?.[1] ??
        text.match(/session id: (\S+)/)?.[1] ??
        null;
      if (
        existsSync(reply) ||
        !text.slice(-4000).includes("Selected model is at capacity") ||
        !session ||
        retries >= 3
      )
        break;
      retries++;
      await delay(timing.retryDelayMs * retries, undefined, {
        signal: controller.signal,
      });
    }
    return { session, reply, log, exit, retries, stoppedAfterReply };
  } finally {
    for (const signal of signals) process.off(signal, interrupt);
    writeFileSync(join(folder, "end.txt"), new Date().toISOString() + "\n");
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
type RunRecord = {
  role: string;
  round: number | null;
  model: string;
  effort: string;
  start: string;
  end: string | null;
  verdict: string;
  session: string | null;
  reply: string;
};
type KnownRun = RunRecord & {
  role: "builder" | "fixer" | "reviewer" | "tester";
};
type UnknownRun = { role: "unknown"; folder: string };
export function laneHistory(
  common: string,
  id: string,
): (KnownRun | UnknownRun)[] {
  const root = join(common, "forge-lane-runs", id);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry): KnownRun | UnknownRun => {
      const folder = join(root, entry.name);
      try {
        const value: unknown = JSON.parse(
          readFileSync(join(folder, "run.json"), "utf8"),
        );
        if (
          !object(value) ||
          !["role", "model", "effort", "start", "verdict", "reply"].every(
            (key) => typeof value[key] === "string",
          ) ||
          !["builder", "fixer", "reviewer", "tester"].includes(
            String(value.role),
          ) ||
          !(value.role === "tester"
            ? Number.isInteger(value.round) &&
              Number(value.round) >= 1 &&
              Number(value.round) <= 10
            : value.round === null) ||
          !["started", "completed", "failed"].includes(String(value.verdict)) ||
          !(value.verdict === "started"
            ? value.end === null
            : typeof value.end === "string") ||
          !(value.session === null || typeof value.session === "string")
        )
          throw new Error("invalid lane run record");
        return value as KnownRun;
      } catch {
        return { role: "unknown", folder };
      }
    })
    .sort((a, b) =>
      (a.role === "unknown" ? "" : a.start).localeCompare(
        b.role === "unknown" ? "" : b.start,
      ),
    );
}
function completed(record: RunRecord) {
  return (
    record.verdict === "completed" &&
    record.end !== null &&
    existsSync(record.reply) &&
    readFileSync(record.reply, "utf8").trim().length > 0
  );
}
function git(worktree: string, args: string[]) {
  const result = spawnSync("git", args, {
    cwd: worktree,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    throw new Error("git command failed while assembling role brief");
  return result.stdout.trim();
}
function roleBrief(
  role: string,
  worktree: string,
  branch: string,
  id: string,
  round: number | null,
  records: RunRecord[],
  pr?: string,
) {
  if (role !== "tester" && role !== "reviewer")
    return readFileSync(join(import.meta.dirname, "lane-brief.md"), "utf8");
  const base = git(worktree, ["merge-base", "origin/main", "HEAD"]);
  let roundText = "";
  if (role === "tester") {
    const previous = records
      .filter((record) => record.role === "tester")
      .at(-1);
    const fix = records
      .filter(
        (record) =>
          ["builder", "fixer"].includes(record.role) &&
          (!previous || record.start > previous.end!),
      )
      .at(-1);
    const path = (record: RunRecord) => record.reply.replaceAll("\\", "/");
    roundText = !previous
      ? `This is test round ${round}.${fix ? ` The builder's reply is ${path(fix)}: treat every claim in it as unverified until you run it.` : " No completed builder or fixer reply is available; treat every implementation claim as unverified until you run it."}${round !== 1 ? " No classified previous tester report is available." : ""}`
      : `This is test round ${round}. The previous report is ${path(previous)}${fix ? ` and the builder's fix reply is ${path(fix)}` : ""}. First re-run every earlier repro and say for each finding whether it is fixed. Then re-run the checks and look for regressions the fixes introduced. New findings are welcome.${!fix ? " No completed builder or fixer reply is available; treat every implementation claim as unverified until you run it." : ""}`;
  }
  const values = {
    WT: worktree.replaceAll("\\", "/"),
    BRANCH: branch,
    BASE: base,
    HEAD: git(worktree, ["rev-parse", "HEAD"]),
    ID: id,
    ROUND: roundText,
    PR: pr ? `PR #${pr}, ` : "",
  };
  return readFileSync(
    join(
      import.meta.dirname,
      role === "tester" ? "lane-test.md" : "lane-review.md",
    ),
    "utf8",
  ).replace(
    /\{\{(WT|BRANCH|BASE|HEAD|ID|ROUND|PR)\}\}/g,
    (_, key: keyof typeof values) => values[key],
  );
}

export async function laneRun(
  argv: string[],
  context: {
    common: string;
    configRoot: string;
    lanes: { issue: string; worktree: string; branch: string; brief: string }[];
    issue: (id: string) => string;
    lock: (id: string) => (pid?: number) => void;
  },
) {
  let role: string | null = null,
    harness: string | null = null,
    model: string | null = null,
    effort: string | null = null,
    folder: string | null = null;
  let unlock: ((pid?: number) => void) | undefined;
  let record: RunRecord | undefined;
  const save = () => {
    if (!record || !folder) return;
    const file = join(folder, "run.json"),
      temp = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`);
      renameSync(temp, file);
    } finally {
      rmSync(temp, { force: true });
    }
  };
  const report = (data: Record<string, unknown>) =>
    console.log(
      JSON.stringify({
        verdict: "refused",
        role,
        harness,
        model,
        effort,
        session: null,
        reply: folder ? join(folder, "reply.md") : null,
        log: folder ? join(folder, "log.txt") : null,
        folder,
        exit: null,
        retries: 0,
        stoppedAfterReply: false,
        next: "correct the input or role table and retry",
        ...data,
      }),
    );
  try {
    const [id, ...flags] = argv,
      values = new Map<string, string>();
    for (let i = 0; i < flags.length; i += 2) {
      const key = flags[i]!,
        value = flags[i + 1];
      if (
        !["--role", "--prompt", "--resume", "--round-cap", "--pr"].includes(
          key,
        ) ||
        !value ||
        values.has(key)
      )
        throw new Error("invalid, duplicate, or missing run option");
      values.set(key, value);
    }
    role = values.get("--role") ?? null;
    if (!id || !role)
      throw new Error(
        "usage: run <issue-id> --role <role> [--prompt <file>] [--resume <session>] [--round-cap 1..10] [--pr N]",
      );
    const cap = values.get("--round-cap") ?? "2",
      pr = values.get("--pr");
    if (!/^(?:[1-9]|10)$/.test(cap))
      throw new Error("round-cap must be an integer from 1 to 10");
    if (pr && (!/^[1-9]\d*$/.test(pr) || !Number.isSafeInteger(Number(pr))))
      throw new Error("pr must be a positive integer");
    const config = Bun.YAML.parse(
      readFileSync(join(context.configRoot, ".forge/config.yaml"), "utf8"),
    );
    const roles: unknown =
      object(config) && object(config.values) && object(config.values.lanes)
        ? config.values.lanes.roles
        : undefined;
    if (!object(roles))
      throw new Error("missing values.lanes.roles table in .forge/config.yaml");
    const entry: unknown = Object.hasOwn(roles, role) ? roles[role] : undefined;
    if (!object(entry))
      throw new Error(`unknown role: ${role}; add it to values.lanes.roles`);
    if (
      !["harness", "model", "effort"].every(
        (key) => typeof entry[key] === "string" && String(entry[key]).trim(),
      )
    )
      throw new Error(
        `invalid role: ${role}; specify harness, model and effort`,
      );
    harness = String(entry.harness);
    model = String(entry.model);
    effort = String(entry.effort);
    if (harness !== "codex")
      throw new Error(`unsupported harness: ${harness}; configure codex`);
    const lane = context.lanes.find((item) => item.issue === id);
    if (!lane) throw new Error(`no active lane for ${id}; use start first`);
    unlock = context.lock(id);
    const history = role === "tester" ? laneHistory(context.common, id) : [];
    const unknown = history.flatMap((item) =>
      item.role === "unknown" ? [item.folder] : [],
    );
    const records = history
      .filter((item): item is KnownRun => item.role !== "unknown")
      .filter(completed);
    const round =
      role === "tester"
        ? records.filter((record) => record.role === "tester").length +
          unknown.length +
          1
        : null;
    if (round !== null && round > Number(cap)) {
      const next = `Test round ${round} exceeds the cap (${cap}). Write a three-line threat model, then choose ship, simplify or park.`;
      report({
        reasons: [
          next,
          ...unknown.map((folder) => `Unknown run folder: ${folder}`),
        ],
        next,
      });
      return 1;
    }
    const custom = values.get("--prompt"),
      resume = values.get("--resume");
    const issue: unknown = custom ? null : JSON.parse(context.issue(id));
    if (
      !custom &&
      (!object(issue) ||
        issue.ok !== true ||
        !object(issue.result) ||
        issue.result.id !== id)
    )
      throw new Error(
        "forge issue show did not return the requested issue successfully",
      );
    const prompt = custom
      ? readFileSync(resolve(custom), "utf8")
      : [
          roleBrief(role, lane.worktree, lane.branch, id, round, records, pr),
          "\nIssue:\n",
          JSON.stringify(issue),
          "\nLane contract (takes precedence):\n",
          readFileSync(lane.brief, "utf8"),
        ].join("\n");
    folder = join(context.common, "forge-lane-runs", id, randomUUID());
    mkdirSync(folder, { recursive: true });
    record = {
      role,
      round,
      model,
      effort,
      start: new Date().toISOString(),
      end: null,
      verdict: "started",
      session: resume ?? null,
      reply: join(folder, "reply.md"),
    };
    save();
    const result = await runCodex({
      worktree: lane.worktree,
      folder,
      model,
      effort,
      prompt,
      started: unlock,
      readOnly: role === "reviewer",
      ...(resume ? { resume } : {}),
    });
    const hasReply =
      existsSync(result.reply) &&
      readFileSync(result.reply, "utf8").trim().length > 0;
    const success = hasReply && (result.exit === 0 || result.stoppedAfterReply);
    Object.assign(record, {
      end: new Date().toISOString(),
      verdict: success ? "completed" : "failed",
      session: result.session,
    });
    save();
    report({
      ...result,
      verdict: success ? "completed" : "failed",
      ...(!hasReply ? { reasons: ["no reply was written"] } : {}),
      next: success
        ? "read the reply and follow the contract stop point"
        : "inspect the log and retry with --resume when a session is available",
    });
    return success ? 0 : 1;
  } catch (error) {
    if (record) {
      record.end = new Date().toISOString();
      record.verdict = "failed";
      save();
    }
    report({
      reasons: [error instanceof Error ? error.message : "lane run failed"],
      next:
        error instanceof Error ? error.message : "inspect the log and retry",
    });
    return 1;
  } finally {
    unlock?.();
  }
}
