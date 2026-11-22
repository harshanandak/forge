import { expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { acceptanceTable } from "./lane-brief-fixture.ts";

export function laneGit(args: string[], cwd: string) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10000,
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

export const laneBrief =
  "Goal|Acceptance test|Files|Forbidden actions|Stop point|Prior art"
    .split("|")
    .map(
      (name) =>
        `## ${name}\nConcrete content.\n${name === "Acceptance test" ? acceptanceTable : ""}\n`,
    )
    .join("\n");

export function laneRepository(
  root: string,
  brief: string,
  options: { ignore?: string; max?: number; checkExit?: number } = {},
) {
  const origin = join(root, "origin.git"),
    repo = join(root, "project");
  laneGit(["init", "--bare", "--initial-branch=main", origin], root);
  laneGit(["clone", origin, repo], root);
  laneGit(["config", "user.name", "Lane test"], repo);
  laneGit(["config", "user.email", "lane@example.test"], repo);
  writeFileSync(join(repo, "tracked"), "base\n");
  if (options.ignore) writeFileSync(join(repo, ".gitignore"), options.ignore);
  laneGit(["add", "."], repo);
  laneGit(["commit", "-m", "base"], repo);
  laneGit(["push", "origin", "main"], repo);
  laneGit(["remote", "set-head", "origin", "main"], repo);
  mkdirSync(join(repo, ".forge"));
  writeFileSync(
    join(repo, ".forge/config.yaml"),
    `schemaVersion: forge.config/1\nblocks:\n  work:\n    source: { builtin: forge/work }\n    bind: { state: core }\n    config: { idPrefix: sample, lanes: { max: ${options.max ?? 3} } }\n` +
      (options.checkExit === undefined
        ? ""
        : `  check:\n    source: { builtin: forge/check }\n    bind: { state: core }\n    config: { commands: { acceptance: { argv: ["node", "-e", "process.exit(${options.checkExit})"] } } }\n`),
  );
  mkdirSync(join(repo, ".worktrees/briefs"), { recursive: true });
  writeFileSync(join(repo, brief), laneBrief);
  mkdirSync(join(root, "bin"));
  return { repo, origin };
}

export function pullFiles(root: string, hosted = false) {
  const dir = join(root, "bin");
  const posix = dir.replaceAll("\\", "/");
  writeFileSync(
    join(dir, "gh"),
    `#!/bin/sh\n${hosted ? `if [ "$1" = api ]; then cat "${posix}/checks.json"; else ` : ""}cat "${posix}/pull.json"${hosted ? "; fi" : ""}\n`,
  );
  chmodSync(join(dir, "gh"), 0o755);
  writeFileSync(
    join(dir, "gh.cmd"),
    `@echo off\r\n${hosted ? 'if "%~1"=="api" (type "%~dp0checks.json") else ' : ""}(type "%~dp0pull.json")\r\n`,
  );
}

export async function laneCommands(root: string, repo: string) {
  const dist = resolve(import.meta.dirname, "../../../dist/src");
  const { createAssembly, localContext } = (await import(
    pathToFileURL(join(dist, "assembly/index.js")).href
  )) as typeof import("../../../src/assembly/index.ts");
  const { runCli } = (await import(
    pathToFileURL(join(dist, "surface/cli.js")).href
  )) as typeof import("../../../src/surface/cli.ts");
  const deviceRoot = join(root, "device");
  const env = { PATH: "", ...process.env };
  env.PATH = [join(root, "bin"), process.env.PATH ?? process.env.Path].join(
    delimiter,
  );
  const assembly = await createAssembly({
    root: repo,
    deviceRoot,
    oneShot: true,
    providers: { env },
  });
  const cli = async (args: string[], session: string) => {
    const context = localContext(
      assembly,
      { kind: "human", id: "local-cli" },
      session,
    );
    const response = await runCli(assembly.catalog, args, {
      caller: "human",
      context: {
        ...context,
        session: { ...context.session, id: session, device: "lane-fixture" },
      },
    });
    return { ...response.envelope, exit: response.exitCode } as {
      exit: number;
      ok: boolean;
      result: Record<string, unknown>;
      error?: { code: string; message: string };
    };
  };
  const call = (op: string, input: object = {}, session = "coordinator") =>
    cli([...op.split("."), "--input", JSON.stringify(input)], session);
  const good = async (op: string, input?: object, session?: string) => {
    const reply = await call(op, input, session);
    expect(reply.ok, JSON.stringify(reply)).toBe(true);
    expect(reply.exit).toBe(0);
    return reply.result;
  };
  return { call, cli, good, dispose: () => assembly.close() };
}
