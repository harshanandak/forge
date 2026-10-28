import { readFile, rm, cp, lstat, stat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  resolve,
  join,
  relative,
  isAbsolute,
  dirname,
  basename,
} from "node:path";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { parse } from "yaml";
import { envValue } from "../src/adapters/process/env.ts";
import { createProcessPort } from "../src/adapters/process/index.ts";
import { createRunnerOutput } from "../src/adapters/runner-output/index.ts";
import defaults from "../src/blocks/check/schemas/config.json" with { type: "json" };
import { schemaDefaults } from "../src/core/config/short.ts";
import { commandArguments } from "../src/blocks/check/command.ts";
import type { CheckConfig } from "../src/blocks/check/types.ts";
const usage =
  "Usage: bun tools/check-admit.ts <check-name> <break.patch> --guard <path> [--guard <path> ...] [--replay N] [--max-seconds S]. Missing tools reported with ordinary failure codes cannot be distinguished from intended failures.";
export async function admit(
  input: {
    root: string;
    name: string;
    patch: string;
    guard: readonly string[];
    replay?: number;
    maxSeconds?: number;
  },
  dependencies: { platform?: NodeJS.Platform; setup?: readonly string[] } = {},
) {
  const names = "clean,break,restore,replay,Windows time".split(",");
  const rows = names.map((name) => ({
    name,
    result: "inconclusive",
    seconds: 0,
    nextStep: "Run after the preceding row passes",
  }));
  const root = await realpath(input.root),
    replay = input.replay ?? 20,
    maxSeconds = input.maxSeconds ?? 120;
  if (
    !Number.isSafeInteger(replay) ||
    !(replay > 0 && maxSeconds > 0 && maxSeconds < Infinity)
  )
    throw new Error("replay and max-seconds must be positive");
  if (!input.guard?.length) throw new Error(usage);
  const guards = input.guard.map((path) => {
    const name = relative(root, resolve(root, path));
    if (
      isAbsolute(path) ||
      !name ||
      isAbsolute(name) ||
      name.split(/[\\/]/).includes("..") ||
      /(^|[\\/])(\.git|\.worktrees)([\\/]|$)/.test(name)
    )
      throw new Error(
        "Guard paths must stay inside the repository, outside .git and .worktrees",
      );
    return name;
  });
  const document = parse(
    await readFile(join(root, ".forge/config.yaml"), "utf8"),
  ) as { blocks?: { check?: { config?: Partial<CheckConfig> } } };
  const baseConfig = Object.fromEntries(
    schemaDefaults(defaults).map(({ key, value }) => [key, value]),
  );
  const config = {
    ...baseConfig,
    ...document.blocks?.check?.config,
  } as CheckConfig;
  const command = config.commands?.[input.name];
  const argv =
    typeof command === "string" ? commandArguments(command) : command?.argv;
  if (!Array.isArray(argv) || !argv[0])
    throw new Error("Name a configured check");
  const inherited = process.env as Record<string, string>;
  const select = (names: readonly string[]) =>
    Object.fromEntries(
      names.flatMap((name) => {
        const value = envValue(inherited, name, process.platform);
        return value === undefined ? [] : [[name, value]];
      }),
    );
  const env = select(config.environment),
    hostEnv = select(defaults.properties.environment.default);
  const processes = createProcessPort({
      supervision: {
        cleanupTimeoutMs: 5000,
        drainTimeoutMs: 1000,
        pollIntervalMs: 25,
        maxConcurrent: 1,
      },
    }),
    controller = new AbortController();
  let interrupted = false;
  const cancel = () => {
    interrupted = true;
    controller.abort();
  };
  const worktrees = await realpath(tmpdir()),
    worktree = join(worktrees, `.admit-${process.pid}-${randomUUID()}`);
  const reportFormat =
    typeof command === "object"
      ? (command.report ?? config.report)
      : config.report;
  const capture = {
    headBytes: config.outputHeadBytes,
    tailBytes: config.outputTailBytes,
  };
  const setupCommand = ["bun", "install", "--frozen-lockfile"];
  let current = rows[0]!;
  async function run(args: readonly string[], cwd: string, check = false) {
    const selected = check ? env : hostEnv,
      executable = processes.resolve(args[0]!, selected);
    if (executable.kind !== "resolved")
      throw new Error(`Executable unavailable: ${args[0]}`);
    const recognizer = createRunnerOutput().recognize(reportFormat);
    const result = await processes.run(executable, args.slice(1), {
      cwd,
      env: selected,
      timeoutMs: check ? config.timeoutMs : 900000,
      maxOutputBytes: config.maxOutputBytes,
      capture,
      ...(check ? { observer: recognizer } : {}),
      signal: controller.signal,
    });
    if (check) current.seconds += result.durationMs / 1000;
    const complete =
      result.outputEvidence &&
      Object.values(result.outputEvidence).every((stream) => stream.complete);
    if (
      !complete ||
      result.timedOut ||
      result.signal ||
      result.exitCode === null
    )
      throw new Error("Command timeout, cancellation or incomplete output");
    const report = recognizer.report();
    if (check && report.kind === "malformed")
      throw new Error("Malformed check report");
    if (check && report.testCount === 0) {
      const commit = await git(["-C", cwd, "rev-parse", "HEAD"]);
      const remedy =
        current.name === "break"
          ? "make the break patch fail an assertion, not skip the tests"
          : `make the ${current.name} row run tests`;
      throw new Error(`The check ran zero tests at ${commit}; ${remedy}`);
    }
    if (check && [126, 127].includes(result.exitCode))
      throw new Error("Missing tool or non-executable command (exit 126/127)");
    const failed = check && !!report.failed;
    return { ...result, passed: result.exitCode === 0 && !failed };
  }
  async function git(args: string[]) {
    const result = await run(["git", ...args], root, false);
    if (!result.passed || result.truncated)
      throw new Error(`git ${args[0]} failed: ${result.stderr}`);
    return result.stdout.trim();
  }
  const wt = (...args: string[]) => git(["-C", worktree, ...args]);
  async function setup() {
    if (!(await run(dependencies.setup ?? setupCommand, worktree)).passed)
      throw new Error("Setup failed");
  }
  // Cleanup must survive the supervised child being interrupted by the same console signal.
  const gitExecutable = processes.resolve("git", hostEnv);
  if (gitExecutable.kind !== "resolved") throw new Error("git is unavailable");
  const nativeGit = (args: string[]) =>
    execFileSync(gitExecutable.path, args, {
      cwd: root,
      env: hostEnv,
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 1048576,
      windowsHide: true,
      stdio: "pipe",
    }).trim();
  const registered = () =>
    nativeGit(["worktree", "list", "--porcelain"])
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => resolve(line.slice(9)));
  async function remove(path: string) {
    await rm(path, { recursive: true, force: true, maxRetries: 3 });
    try {
      nativeGit(["worktree", "remove", "--force", "--force", path]);
    } catch (error) {
      if (registered().includes(path)) throw error;
    }
  }
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    for (let parent = worktrees; ; parent = dirname(parent)) {
      const modules = join(parent, "node_modules");
      const folder = await stat(modules).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return undefined;
        },
      );
      if (folder?.isDirectory())
        throw new Error(`Ancestor node_modules folder: ${modules}`);
      if (parent === dirname(parent)) break;
    }
    for (const path of registered()) {
      const owner = /^\.admit-(\d+)-/.exec(basename(path));
      if (dirname(path) !== worktrees || !owner) continue;
      try {
        process.kill(Number(owner[1]), 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH")
          await remove(path);
      }
    }
    const base = await git(["rev-parse", "origin/main"]);
    await git(["worktree", "add", "--detach", worktree, base]);
    for (const [index, row] of rows.entries()) {
      current = row;
      if (index === 2)
        await wt("apply", "--reverse", resolve(root, input.patch));
      const count = `--max-count=${replay}`;
      const history = ["rev-list", "--first-parent", count, `${base}^`];
      const commits =
        row.name === "replay" ? (await git(history)).split("\n") : [base];
      if (commits.length < replay && row.name === "replay")
        throw new Error(`Need ${replay} previous first-parent commits`);
      row.result = "pass";
      row.nextStep = "Continue to the next row";
      for (const commit of commits) {
        await wt("checkout", "--detach", "--force", commit);
        await wt("clean", "-ffdx");
        for (const path of guards) {
          const target = join(worktree, path);
          await rm(target, { recursive: true, force: true });
          await cp(join(root, path), target, {
            recursive: true,
            filter: async (source) => {
              if ((await lstat(source)).isSymbolicLink())
                throw new Error("Guard symlinks are unsupported");
              return true;
            },
          });
        }
        if (index === 1) await wt("apply", resolve(root, input.patch));
        await setup();
        if (index === 4) {
          row.seconds = Math.max(rows[0]!.seconds, rows[2]!.seconds);
          row.result = row.seconds < maxSeconds ? "pass" : "fail";
          row.nextStep = `Limit: ${maxSeconds} seconds; reduce runtime if exceeded`;
          if ((dependencies.platform ?? process.platform) !== "win32") {
            row.result = "inconclusive";
            row.nextStep = "not measured on Windows";
          }
          break;
        }
        const result = await run(argv, worktree, true);
        if (result.passed === (row.name === "break")) {
          row.result = "fail";
          row.nextStep = `Fix ${row.name} at ${commit}: expected ${row.name === "break" ? "failure" : "pass"}`;
          break;
        }
      }
      if (row.result !== "pass") break;
    }
  } catch (error) {
    current.result = "inconclusive";
    current.nextStep = error instanceof Error ? error.message : String(error);
  } finally {
    await remove(worktree).finally(() => {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
    });
  }
  const first = rows.find((row) => row.result !== "pass");
  return {
    rows,
    verdict: first ? ("refuse" as const) : ("admit" as const),
    ...(first ? { firstFailingRow: first.name } : {}),
    exitCode: interrupted ? 130 : first ? (first.result === "fail" ? 1 : 2) : 0,
  };
}
if (import.meta.main) {
  try {
    const args = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        guard: { type: "string", multiple: true },
        help: { type: "boolean" },
        replay: { type: "string" },
        "max-seconds": { type: "string" },
      },
    });
    if (args.values.help) {
      console.log(usage);
      process.exit(0);
    }
    const [name, patch] = args.positionals;
    if (!name || !patch || args.positionals.length !== 2)
      throw new Error(usage);
    const result = await admit({
      root: process.cwd(),
      guard: args.values.guard ?? [],
      name,
      patch,
      replay: Number(args.values.replay ?? 20),
      maxSeconds: Number(args.values["max-seconds"] ?? 120),
    });
    console.log(JSON.stringify(result));
    process.exitCode = result.exitCode;
  } catch (error) {
    console.log(
      JSON.stringify({
        rows: [],
        verdict: "refuse",
        nextStep: String(error),
      }),
    );
    process.exitCode = 2;
  }
}
