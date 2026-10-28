import { readFile, readdir, mkdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { parse } from "yaml";
import { envValue } from "../src/adapters/process/env.ts";
import { createProcessPort } from "../src/adapters/process/index.ts";
import { createRunnerOutput } from "../src/adapters/runner-output/index.ts";
import defaults from "../src/blocks/check/schemas/config.json" with { type: "json" };
import { schemaDefaults } from "../src/core/config/short.ts";
import type { CheckConfig } from "../src/blocks/check/types.ts";
function argumentsFor(text: string): string[] {
  const token = /\s*((?:[^\s"'|&;<>`$]+|"[^"]*"|'[^']*')+)\s*/gy;
  const args: string[] = [];
  while (token.lastIndex < text.length) {
    const match = token.exec(text);
    if (!match) throw new Error("Invalid command; use argv");
    args.push(
      match[1]!.replace(/"[^"]*"|'[^']*'/g, (value) => value.slice(1, -1)),
    );
  }
  return args;
}
export async function admit(
  input: {
    root: string;
    name: string;
    patch: string;
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
  const root = resolve(input.root),
    replay = input.replay ?? 20,
    maxSeconds = input.maxSeconds ?? 120;
  if (
    !Number.isSafeInteger(replay) ||
    !(replay > 0 && maxSeconds > 0 && maxSeconds < Infinity)
  )
    throw new Error("replay and max-seconds must be positive");
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
    typeof command === "string" ? argumentsFor(command) : command?.argv;
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
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  const worktrees = join(root, ".worktrees"),
    worktree = join(worktrees, `.admit-${randomUUID()}`);
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
  async function run(
    args: readonly string[],
    cwd: string,
    check = false,
    cleanup = false,
  ) {
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
      ...(cleanup ? {} : { signal: controller.signal }),
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
    const failed = check && (report.testCount === 0 || !!report.failed);
    return { ...result, passed: result.exitCode === 0 && !failed };
  }
  async function git(args: string[], cleanup = false) {
    const result = await run(["git", ...args], root, false, cleanup);
    if (!result.passed || result.truncated)
      throw new Error(`git ${args[0]} failed: ${result.stderr}`);
    return result.stdout.trim();
  }
  const wt = (...args: string[]) => git(["-C", worktree, ...args]);
  async function setup() {
    if (!(await run(dependencies.setup ?? setupCommand, worktree)).passed)
      throw new Error("Setup failed");
  }
  async function remove(path: string) {
    await rm(path, { recursive: true, force: true, maxRetries: 3 });
    await git(["worktree", "prune"], true);
  }
  try {
    await mkdir(worktrees, { recursive: true });
    for (const name of await readdir(worktrees))
      if (name.startsWith(".admit-")) await remove(join(worktrees, name));
    const base = await git(["rev-parse", "origin/main"]);
    await git(["worktree", "add", "--detach", worktree, base]);
    for (const [index, row] of rows.entries()) {
      current = row;
      if (row.name === "Windows time") {
        await setup();
        row.seconds = Math.max(rows[0]!.seconds, rows[2]!.seconds);
        const windows = (dependencies.platform ?? process.platform) === "win32";
        row.result = row.seconds < maxSeconds ? "pass" : "fail";
        row.nextStep = `Limit: ${maxSeconds} seconds; reduce runtime if exceeded`;
        if (!windows) {
          row.result = "inconclusive";
          row.nextStep = "not measured on Windows";
        }
        break;
      }
      if (index === 1 || index === 2)
        await wt(
          "apply",
          ...(index === 2 ? ["--reverse"] : []),
          resolve(root, input.patch),
        );
      const count = `--max-count=${replay}`;
      const history = ["rev-list", "--first-parent", count, `${base}^`];
      const commits =
        row.name === "replay" ? (await git(history)).split("\n") : [base];
      if (commits.length < replay && row.name === "replay")
        throw new Error(`Need ${replay} previous first-parent commits`);
      row.result = "pass";
      row.nextStep = "Continue to the next row";
      for (const commit of commits) {
        if (row.name === "replay") {
          await wt("checkout", "--detach", "--force", commit);
          await wt("clean", "-ffd");
        }
        await setup();
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
    current.nextStep = String(error);
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
    exitCode: first ? (first.result === "fail" ? 1 : 2) : 0,
  };
}
if (import.meta.main) {
  try {
    const args = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        replay: { type: "string" },
        "max-seconds": { type: "string" },
      },
    });
    const [name, patch] = args.positionals;
    if (!name || !patch || args.positionals.length !== 2)
      throw new Error("Expected check name and break.patch");
    const result = await admit({
      root: process.cwd(),
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
