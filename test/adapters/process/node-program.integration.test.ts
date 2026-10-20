// [integration] Real subprocesses. The adapter is exercised by a Node program (the shipped runtime),
// not by Bun, and this test asserts on the structured outcome that program prints.
import { beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const fixture = join(
  import.meta.dirname,
  "../../node-fixtures/process/spawn.fixture.ts",
);

interface Run {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

interface Outcomes {
  platform: string;
  output: Run;
  shimResolvedTo: string;
  shim: Run;
  injection: Run;
  injectionFileCreated: boolean;
  percent: Run | { code: string };
  quote: Run | { code: string };
  stdin: Run;
  truncated: Run;
  envIsolation: Run;
  missingCommand: { kind: string; reason: string; remedy: string };
  badCwd: { code: string };
  timeout: Run & { treeAlive: boolean };
  cancel: Run & { treeAlive: boolean };
}

let outcomes: Outcomes;
let bunOutcomes: Outcomes;

function runFixture(runtime: string, flags: string[]): Outcomes {
  // FORGE_PROCESS_ENTRY points the same program at the built package (dist) in the pack smoke.
  const entry = process.env["FORGE_PROCESS_ENTRY"];
  const args = [...flags, fixture, ...(entry === undefined ? [] : [entry])];
  const run = spawnSync(runtime, args, {
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
  });
  if (run.status !== 0) {
    throw new Error(
      `the ${runtime} fixture failed (${run.status}): ${run.stderr || run.error?.message}`,
    );
  }
  return JSON.parse(run.stdout) as Outcomes;
}

beforeAll(() => {
  outcomes = runFixture("node", ["--disable-warning=ExperimentalWarning"]);
  bunOutcomes = runFixture(process.execPath, []);
}, 150_000);

const windows = process.platform === "win32";

test("a real command returns its output and its exit code", () => {
  expect(outcomes.output).toMatchObject({
    exitCode: 3,
    stdout: "out",
    stderr: "err",
    timedOut: false,
    truncated: false,
  });
}, 30_000);

test("a shim named like npm resolves to the runnable file and runs with every argument intact (old issues 9997d516, c4393667)", () => {
  expect(outcomes.shimResolvedTo.toLowerCase()).toMatch(
    windows ? /shim\.cmd$/ : /shim$/,
  );
  expect(outcomes.shim.exitCode).toBe(7);
  expect(JSON.parse(outcomes.shim.stdout)).toEqual([
    "plain",
    "two words",
    "amp&ersand",
    "pipe|bar",
    "(paren)",
    "care^t",
    "<angle>",
    "--flag=with space",
    "trailing\\",
    "",
  ]);
}, 30_000);

test("an argument with shell syntax is data, never a second command", () => {
  expect(outcomes.injection.exitCode).toBe(7);
  expect(JSON.parse(outcomes.injection.stdout)).toEqual([
    "& echo pwned > pwned.txt",
  ]);
  expect(outcomes.injectionFileCreated).toBe(false);
}, 30_000);

test("arguments cmd.exe would expand are refused on Windows and passed literally elsewhere", () => {
  if (windows) {
    expect(outcomes.percent).toMatchObject({ code: "UNSAFE_ARGUMENT" });
    expect(outcomes.quote).toMatchObject({ code: "UNSAFE_ARGUMENT" });
  } else {
    expect(JSON.parse((outcomes.percent as Run).stdout)).toEqual(["%PATH%"]);
    expect(JSON.parse((outcomes.quote as Run).stdout)).toEqual(['say "hi"']);
  }
}, 30_000);

test("stdin reaches the child and closes", () => {
  expect(outcomes.stdin).toMatchObject({ exitCode: 0, stdout: "PIPE ME" });
}, 30_000);

test("output beyond the budget is dropped and reported, what was kept is returned", () => {
  expect(outcomes.truncated.truncated).toBe(true);
  expect(outcomes.truncated.stdout).toHaveLength(1000);
  expect(outcomes.truncated.exitCode).toBe(0);
}, 30_000);

test("the child gets exactly the environment it was given", () => {
  expect(outcomes.envIsolation.stdout).toBe("undefined");
}, 30_000);

test("a missing command is Unavailable and a bad working directory is a typed rejection", () => {
  expect(outcomes.missingCommand.kind).toBe("unavailable");
  expect(outcomes.missingCommand.remedy).toContain("PATH");
  expect(outcomes.badCwd).toMatchObject({ code: "INVALID_OPTIONS" });
}, 30_000);

test.each(["node", "bun"])(
  "under %s, timeout and cancellation stop the child and its grandchild",
  (runtime) => {
    const ran = runtime === "node" ? outcomes : bunOutcomes;
    expect(ran.timeout).toMatchObject({
      timedOut: true,
      exitCode: null,
      treeAlive: false,
    });
    expect(ran.cancel).toMatchObject({
      timedOut: false,
      exitCode: null,
      treeAlive: false,
    });
  },
  30_000,
);
