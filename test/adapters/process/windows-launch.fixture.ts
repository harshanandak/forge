// Runs the Windows launcher and Node's own spawn against the same corpus. The same file is the
// echo child and the grandchild programs, and prints a full report when Node runs it directly.
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  planSpawn,
  type SpawnPlan,
} from "../../../src/adapters/process/plan.ts";
import { openWindowsJob } from "../../../src/adapters/process/windows-job.ts";
import {
  closeLaunchedProcess,
  launchInJob,
} from "../../../src/adapters/process/windows-launch.ts";
import { waitUntilGone } from "../../node-fixtures/process/liveness.ts";

export const fixturePath = fileURLToPath(import.meta.url);

// Commands start outside the working folder, so no process keeps that folder busy after it ends.
const neutralCwd = tmpdir();

export interface Case {
  readonly name: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** Run through a .cmd shim, so the plan is the verbatim cmd.exe plan. */
  readonly shim?: boolean;
}
export interface Echo {
  readonly argv: readonly string[];
  readonly env: readonly (readonly [string, string])[];
}

const root = process.env.SystemRoot ?? "C:\\Windows";
const base = { Forge_Case: "base", lower_key: "x" };
const argvCases: readonly (readonly string[])[] = [
  [],
  ["plain"],
  ["two words"],
  ["tab\there"],
  ['say "hi"'],
  ['"quoted"'],
  ["trailing\\"],
  ["trailing space \\"],
  ["double\\\\"],
  ["back\\slash"],
  ['a\\"b'],
  ['a\\\\"b'],
  [""],
  ["", ""],
  ["a", "", "b"],
  ["é ü ñ"],
  ["日本語 テスト"],
  ["emoji 😀 ok"],
  ["--flag=value", "-x"],
  ["--", "-e"],
  ["C:\\Program Files\\x y\\", "z"],
  ["a&b|c<d>e^f"],
  ["%PATH% !x!"],
  ["*", "?", "[a]"],
  ["'single'"],
  ['""'],
  ['\\"'],
  ["   "],
  ["x".repeat(500)],
  ["multi\nline"],
];
const envCases: readonly Record<string, string>[] = [
  {},
  { A: "1" },
  { EMPTY: "" },
  { zeta: "1", Alpha: "2", beta: "3", ALPHA2: "4" },
  { Ünï: "vä", Ключ: "значение" },
  { "emoji😀": "v😀" },
  { PATH: "C:\\nowhere" },
  { SystemRoot: root },
  { systemroot: root },
  { V: "a=b=c", "SPACE KEY": "v w", k: "line1\nline2" },
  // Names that differ only by case: Node keeps the first in sorted order.
  { Path: "lower", PATH: "upper" },
  { foo: "a", FOO: "b" },
  { fOO: "3", Foo: "1", FOO: "2", other: "x" },
];
const shimCases: readonly (readonly string[])[] = [
  ["plain"],
  ["with space", "trailing\\"],
  ["a&b", "(x)", "é"],
  [],
];

export function corpus(): readonly Case[] {
  return [
    ...argvCases.map((args, index) => ({
      name: `argv ${index}`,
      args,
      env: base,
    })),
    ...envCases.map((env, index) => ({
      name: `env ${index}`,
      args: ["e"],
      env,
    })),
    ...shimCases.map((args, index) => ({
      name: `cmd ${index}`,
      args,
      env: { ...base, SystemRoot: root },
      shim: true,
    })),
  ];
}

export function planFor(
  testCase: Case,
  index: number,
  dir: string,
  label: string,
  nodePath: string,
): { readonly plan: SpawnPlan; readonly out: string } {
  mkdirSync(join(dir, label), { recursive: true });
  const out = join(dir, label, `${index}.json`);
  if (testCase.shim !== true) {
    const args = [fixturePath, "echo", out, ...testCase.args];
    return { plan: planSpawn(nodePath, args, testCase.env, "win32"), out };
  }
  const shim = join(dir, label, `${index}.cmd`);
  writeFileSync(shim, `@"${nodePath}" "${fixturePath}" echo "${out}" %*\r\n`);
  return { plan: planSpawn(shim, testCase.args, testCase.env, "win32"), out };
}

export function referenceCase(
  testCase: Case,
  plan: SpawnPlan,
  out: string,
): Echo {
  rmSync(out, { force: true });
  const run = spawnSync(plan.file, [...plan.args], {
    cwd: neutralCwd,
    env: { ...testCase.env },
    windowsHide: true,
    windowsVerbatimArguments: plan.windowsVerbatimArguments,
    stdio: "ignore",
    timeout: 20_000,
  });
  if (run.status !== 0)
    throw new Error(`${testCase.name}: reference exited ${run.status}`);
  return JSON.parse(readFileSync(out, "utf8")) as Echo;
}

async function waitForJson<T>(file: string): Promise<T> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as T;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`${file} was never written`);
}

export async function launchedCase(
  testCase: Case,
  plan: SpawnPlan,
  out: string,
): Promise<Echo> {
  const job = openWindowsJob({ cleanupTimeoutMs: 5000, pollIntervalMs: 25 });
  let launched: ReturnType<typeof launchInJob> | undefined;
  try {
    launched = launchInJob(plan, job, { cwd: neutralCwd, env: testCase.env });
    return await waitForJson<Echo>(out);
  } finally {
    // Each release step runs even if the one before it throws.
    try {
      await job.stop();
    } finally {
      try {
        if (launched !== undefined) closeLaunchedProcess(launched);
      } finally {
        job.close();
      }
    }
  }
}

export interface GrandchildReport {
  readonly child: number;
  readonly grandchild: number;
  readonly whileParentRuns: readonly number[];
  readonly afterParentExit: readonly number[];
  readonly parentGone: boolean;
  readonly stopped: readonly number[];
  readonly grandchildGone: boolean;
}

/** A command starts a detached grandchild and waits; the job must hold both, then end both. */
export async function grandchildScenario(
  nodePath: string,
  dir: string,
  label: string,
): Promise<GrandchildReport> {
  mkdirSync(join(dir, label), { recursive: true });
  const pids = join(dir, label, "pids.json");
  const release = join(dir, label, "release");
  const job = openWindowsJob({ cleanupTimeoutMs: 5000, pollIntervalMs: 25 });
  let launched: ReturnType<typeof launchInJob> | undefined;
  try {
    launched = launchInJob(
      {
        file: nodePath,
        args: [fixturePath, "parent", pids, release],
        windowsVerbatimArguments: false,
      },
      job,
      { cwd: neutralCwd, env: {} },
    );
    const { child, grandchild } = await waitForJson<{
      child: number;
      grandchild: number;
    }>(pids);
    const whileParentRuns = job.members();
    writeFileSync(release, "go");
    const parentGone = await waitUntilGone([child]);
    const afterParentExit = job.members();
    const stopped = await job.stop();
    return {
      child,
      grandchild,
      whileParentRuns,
      afterParentExit,
      parentGone,
      stopped,
      grandchildGone: await waitUntilGone([grandchild]),
    };
  } finally {
    if (launched !== undefined) closeLaunchedProcess(launched);
    job.close();
  }
}

/** A relative program path is refused before anything starts. */
export function relativeScenario(): {
  readonly refused: readonly { code: unknown; started: number }[];
} {
  const job = openWindowsJob({ cleanupTimeoutMs: 5000, pollIntervalMs: 25 });
  try {
    const refused = [
      "node.exe",
      ".\\node.exe",
      "sub\\node.exe",
      "\\node.exe",
    ].map((file) => {
      let code: unknown = "launched";
      try {
        const launched = launchInJob(
          { file, args: [], windowsVerbatimArguments: false },
          job,
          { cwd: neutralCwd, env: {} },
        );
        closeLaunchedProcess(launched);
      } catch (error) {
        code = (error as { code?: unknown }).code;
      }
      return { code, started: job.members().length };
    });
    return { refused };
  } finally {
    job.close();
  }
}

const isEntry =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]).toLowerCase() === fixturePath.toLowerCase();

if (isEntry) {
  const [mode, first, second] = process.argv.slice(2);
  if (mode === "echo" && first !== undefined) {
    writeFileSync(
      `${first}.tmp`,
      JSON.stringify({
        argv: process.argv.slice(4),
        env: Object.entries(process.env),
      }),
    );
    renameSync(`${first}.tmp`, first);
  } else if (mode === "sleep") {
    setTimeout(() => undefined, 60_000);
  } else if (mode === "parent" && first !== undefined && second !== undefined) {
    const grandchild = spawn(process.execPath, [fixturePath, "sleep"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    grandchild.unref();
    writeFileSync(
      `${first}.tmp`,
      JSON.stringify({
        child: process.pid,
        grandchild: grandchild.pid,
      }),
    );
    renameSync(`${first}.tmp`, first);
    const waiter = setInterval(() => {
      if (existsSync(second)) clearInterval(waiter);
    }, 20);
  } else if (mode === "run" && first !== undefined) {
    const results = [];
    for (const [index, testCase] of corpus().entries()) {
      const { plan, out } = planFor(
        testCase,
        index,
        first,
        "node",
        process.execPath,
      );
      results.push({
        name: testCase.name,
        launched: await launchedCase(testCase, plan, out),
        reference: referenceCase(testCase, plan, out),
      });
    }
    process.stdout.write(
      JSON.stringify({
        results,
        grandchild: await grandchildScenario(
          process.execPath,
          first,
          "node-gc",
        ),
        relative: relativeScenario(),
      }),
    );
  }
}
