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
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join, resolve } from "node:path";

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
function run(command: string, args: string[], cwd = process.cwd()) {
  // npm and the installed Forge provide an extensionless shell shim beside forge.cmd.
  // sh preserves JSON arguments on Windows without cmd.exe's quote reinterpretation.
  if (command === "forge" && process.platform === "win32") {
    const path =
      Object.entries(process.env).find(
        ([key]) => key.toLowerCase() === "path",
      )?.[1] ?? "";
    const shim = path
      .split(delimiter)
      .map((part) => join(part.replace(/^"|"$/g, ""), "forge"))
      .find(existsSync);
    if (!shim)
      throw new Error("installed forge shell shim was not found on PATH");
    args = [shim, ...args];
    command = "sh";
  }
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    throw new Error(`${command === "sh" ? "forge" : command} command failed`);
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
function options(argv: string[]): Options | "list" {
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
      "usage: start <issue-id> --branch <name> --brief <file> [--max N], or list",
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
    const match = owner?.match(/^owner-([1-9]\d*)-[0-9a-f-]{36}$/);
    if (!match) return;
    try {
      process.kill(Number(match[1]), 0);
      return;
    } catch (error) {
      if (!object(error) || error.code !== "ESRCH") return;
    }
    release(lock, owner!);
  } catch (error) {
    if (!object(error) || error.code !== "ENOENT") throw error;
  }
}
function main(): number {
  let parsed: Options | "list";
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
  const owner = `owner-${process.pid}-${randomUUID()}`;
  let held = false;
  try {
    const common = resolve(
      run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    );
    const root = resolve(
      run("git", ["--git-dir", common, "worktree", "list", "--porcelain", "-z"])
        .split("\0")[0]!
        .slice(9),
    );
    const registry = join(common, "forge-lanes.json");
    if (parsed === "list") {
      console.log(JSON.stringify({ lanes: active(registry, root) }));
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
process.exitCode = main();
