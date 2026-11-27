import { expect } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acceptanceTable } from "./lane-brief-fixture.ts";

type LaneReply = {
  exit: number | null;
  ok: boolean;
  result: Record<string, unknown>;
  error?: { code: string; message: string };
};

const built = (name: string) =>
  new URL(`../../../dist/src/${name}.js`, import.meta.url).href;
export const linuxAdvisory =
  process.platform === "linux" && existsSync("/var/lib/dpkg/info/git.md5sums");
export const { processStartTime } = (await import(
  built("adapters/process/index")
)) as typeof import("../../../src/adapters/process/index.ts");

export const laneBin = fileURLToPath(
  new URL("../../../dist/bin/forge.js", import.meta.url),
);

export function laneCli(
  root: string,
  cwd: string,
  args: string[],
  session: string,
  env: NodeJS.ProcessEnv = {},
  nodeArgs: readonly string[] = [],
) {
  const result = spawnSync("node", [...nodeArgs, laneBin, ...args], {
    cwd,
    env: {
      ...process.env,
      ...env,
      FORGE_DEVICE_ROOT: join(root, "device"),
      FORGE_SESSION: session,
    },
    encoding: "utf8",
    windowsHide: true,
    timeout: 20000,
  });
  expect(result.error).toBeUndefined();
  return { ...JSON.parse(result.stdout), exit: result.status } as LaneReply;
}

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
  options: {
    ignore?: string;
    max?: number;
    base?: string;
    checkExit?: number;
  } = {},
) {
  const origin = join(root, "origin.git"),
    repo = join(root, "project");
  laneGit(["init", "--bare", "--initial-branch=main", origin], root);
  laneGit(
    [
      "clone",
      "-c",
      "user.name=Lane test",
      "-c",
      "user.email=lane@example.test",
      origin,
      repo,
    ],
    root,
  );
  writeFileSync(join(repo, "tracked"), "base\n");
  if (options.ignore) writeFileSync(join(repo, ".gitignore"), options.ignore);
  laneGit(["add", "."], repo);
  laneGit(["commit", "-m", "base"], repo);
  laneGit(["push", "origin", "main"], repo);
  laneGit(["remote", "set-head", "origin", "main"], repo);
  mkdirSync(join(repo, ".forge"));
  writeFileSync(
    join(repo, ".forge/config.yaml"),
    `schemaVersion: forge.config/1\nblocks:\n  work:\n    source: { builtin: forge/work }\n    bind: { state: core }\n    config: { idPrefix: sample, lanes: ${JSON.stringify({ max: options.max ?? 3, base: options.base })} }\n` +
      (options.checkExit === undefined
        ? ""
        : `  check:\n    source: { builtin: forge/check }\n    bind: { state: core }\n    config: { commands: { acceptance: { argv: ["node", "-e", "process.exit(${options.checkExit})"] } } }\n`),
  );
  mkdirSync(join(repo, ".worktrees/briefs"), { recursive: true });
  writeFileSync(join(repo, brief), laneBrief);
  mkdirSync(join(root, "bin"));
  return { repo, origin };
}

export function pullFiles(root: string) {
  const dir = join(root, "bin");
  const posix = dir.replaceAll("\\", "/");
  writeFileSync(
    join(dir, "gh"),
    `#!/bin/sh\nif [ "$1" = api ]; then cat "${posix}/checks.json"; else cat "${posix}/pull.json"; fi\n`,
  );
  chmodSync(join(dir, "gh"), 0o755);
  writeFileSync(
    join(dir, "gh.cmd"),
    '@echo off\r\nif "%~1"=="api" (type "%~dp0checks.json") else (type "%~dp0pull.json")\r\n',
  );
}

export async function laneCommands(root: string, repo: string) {
  const { createAssembly, localContext } = (await import(
    built("assembly/index")
  )) as typeof import("../../../src/assembly/index.ts");
  const { runCli } = (await import(
    built("surface/cli")
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
  const cli = async (args: string[], session = "coordinator") => {
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
    return { ...response.envelope, exit: response.exitCode } as LaneReply;
  };
  const call = (op: string, input: object = {}, session?: string) =>
    cli([...op.split("."), "--input", JSON.stringify(input)], session);
  const good = async (op: string, input?: object, session?: string) => {
    const reply = await call(op, input, session);
    expect(reply.ok, JSON.stringify(reply)).toBe(true);
    expect(reply.exit).toBe(0);
    return reply.result;
  };
  return { call, cli, good, dispose: () => assembly.close() };
}

type Commands = Awaited<ReturnType<typeof laneCommands>>;
export async function advisoryProject(
  brief: string,
  use: (commands: Commands, repo: string, root: string) => Promise<void>,
  configure = "",
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "forge-advisory-")));
  let commands: Commands | undefined;
  try {
    const { repo } = laneRepository(root, brief);
    const path = join(repo, ".forge/config.yaml");
    if (configure) writeFileSync(path, readFileSync(path, "utf8") + configure);
    laneGit(["add", ".forge/config.yaml"], repo);
    laneGit(["commit", "-m", "advisory policy"], repo);
    laneGit(["push", "origin", "main"], repo);
    commands = await laneCommands(root, repo);
    await use(commands, repo, root);
  } finally {
    try {
      await commands?.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}
