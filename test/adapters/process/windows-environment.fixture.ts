// Runs a command through the process adapter with a deliberately small environment and reports
// which variable names reach it. The same file is the child program, and prints a report under Node.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "../../../src/adapters/process/run.ts";

export const fixturePath = fileURLToPath(import.meta.url);

/** Variables the caller below never passes, so none may reach the command, whether or not the host has them. */
export const HOST_ONLY = [
  "PATH",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "USERNAME",
  "FORGE_LEAK_SENTINEL",
] as const;

export interface EnvironmentReport {
  /** PATH, TEMP, USERPROFILE and the sentinel are set in this host, so a clean result is not vacuous. */
  readonly hostHasThem: boolean;
  /** Names the command saw when the caller passed SystemRoot itself. */
  readonly withSystemRoot: readonly string[];
  /** Names the command saw when the caller left SystemRoot out. */
  readonly withoutSystemRoot: readonly string[];
  /** A .cmd run with only PATH in its environment: whether it ran, and the names it saw. */
  readonly cmdShim: {
    readonly exitCode: number | null;
    readonly printedMarker: boolean;
    readonly names: readonly string[];
  };
}

export const CMD_MARKER = "forge-cmd-shim-ran";

const supervision = {
  cleanupTimeoutMs: 5000,
  pollIntervalMs: 25,
  drainTimeoutMs: 250,
  maxConcurrent: 1,
};

async function namesSeenBy(
  nodePath: string,
  env: Readonly<Record<string, string>>,
): Promise<readonly string[]> {
  const result = await runProcess(
    nodePath,
    ["-e", "process.stdout.write(JSON.stringify(Object.keys(process.env)))"],
    { cwd: tmpdir(), env, timeoutMs: 30_000, maxOutputBytes: 65_536 },
    "win32",
    { supervision },
  );
  if (result.exitCode !== 0)
    throw new Error(`the environment probe exited ${result.exitCode}`);
  return JSON.parse(result.stdout) as string[];
}

/** With neither SystemRoot nor ComSpec in the caller's environment, a .cmd must still start. */
async function cmdShimReport(): Promise<EnvironmentReport["cmdShim"]> {
  const dir = realpathSync.native(
    mkdtempSync(join(tmpdir(), "forge-cmd-shim-")),
  );
  try {
    const shim = join(dir, "marker.cmd");
    writeFileSync(shim, `@echo ${CMD_MARKER}\r\n@set\r\n`);
    const result = await runProcess(
      shim,
      [],
      {
        cwd: tmpdir(),
        env: { PATH: dir },
        timeoutMs: 30_000,
        maxOutputBytes: 65_536,
      },
      "win32",
      { supervision },
    );
    const names = result.stdout
      .split(/\r?\n/)
      .map((line) => /^([^=\s][^=]*)=/.exec(line)?.[1])
      .filter((name): name is string => name !== undefined);
    return {
      exitCode: result.exitCode,
      printedMarker: result.stdout.includes(CMD_MARKER),
      names,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function environmentReport(
  nodePath: string,
): Promise<EnvironmentReport> {
  process.env.FORGE_LEAK_SENTINEL = "set-in-the-host";
  const hostHasThem = [
    "PATH",
    "TEMP",
    "USERPROFILE",
    "FORGE_LEAK_SENTINEL",
  ].every((name) => process.env[name] !== undefined);
  const root = process.env.SystemRoot ?? "C:\\Windows";
  try {
    return {
      hostHasThem,
      withSystemRoot: await namesSeenBy(nodePath, {
        SystemRoot: root,
        FORGE_ALLOWED: "kept",
      }),
      withoutSystemRoot: await namesSeenBy(nodePath, { FORGE_ALLOWED: "kept" }),
      cmdShim: await cmdShimReport(),
    };
  } finally {
    delete process.env.FORGE_LEAK_SENTINEL;
  }
}

const isEntry =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]).toLowerCase() === fixturePath.toLowerCase();

if (isEntry)
  process.stdout.write(
    JSON.stringify(await environmentReport(process.execPath)),
  );
