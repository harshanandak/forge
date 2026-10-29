import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
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
export async function laneRun(
  argv: string[],
  context: {
    common: string;
    configRoot: string;
    lanes: { issue: string; worktree: string; brief: string }[];
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
        !["--role", "--prompt", "--resume"].includes(key) ||
        !value ||
        values.has(key)
      )
        throw new Error("invalid, duplicate, or missing run option");
      values.set(key, value);
    }
    role = values.get("--role") ?? null;
    if (!id || !role)
      throw new Error(
        "usage: run <issue-id> --role <role> [--prompt <file>] [--resume <session>]",
      );
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
          readFileSync(join(import.meta.dirname, "lane-brief.md"), "utf8"),
          "\nIssue:\n",
          JSON.stringify(issue),
          "\nLane contract (takes precedence):\n",
          readFileSync(lane.brief, "utf8"),
        ].join("\n");
    unlock = context.lock(id);
    folder = join(context.common, "forge-lane-runs", id, randomUUID());
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
