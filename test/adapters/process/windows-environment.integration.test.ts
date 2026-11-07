// [integration] On Windows a command gets exactly the environment its caller passed, plus SystemRoot.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  environmentReport,
  fixturePath,
  HOST_ONLY,
  type EnvironmentReport,
} from "./windows-environment.fixture.ts";

const windows = process.platform === "win32";
const nodePath = windows ? (Bun.which("node") ?? "") : "";

let nodeRun: EnvironmentReport | undefined;
function underNode(): EnvironmentReport {
  if (nodeRun !== undefined) return nodeRun;
  const run = spawnSync(nodePath, [fixturePath], {
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
  });
  if (run.status !== 0)
    throw new Error(`node run failed: ${run.stderr || run.error?.message}`);
  nodeRun = JSON.parse(run.stdout) as EnvironmentReport;
  return nodeRun;
}

const upper = (names: readonly string[]): string[] =>
  names.map((name) => name.toUpperCase()).toSorted();

function expectCallerEnvironmentOnly(report: EnvironmentReport): void {
  expect(
    report.hostHasThem,
    "the host must have the variables it could leak",
  ).toBe(true);
  for (const names of [report.withSystemRoot, report.withoutSystemRoot])
    for (const leaked of HOST_ONLY)
      expect(
        upper(names),
        `${leaked} must not reach the command`,
      ).not.toContain(leaked);
  // The caller passed SystemRoot: nothing is added.
  expect(upper(report.withSystemRoot)).toEqual(["FORGE_ALLOWED", "SYSTEMROOT"]);
  // The caller left it out: SystemRoot alone is added, as the old helper path gave every command.
  expect(upper(report.withoutSystemRoot)).toEqual([
    "FORGE_ALLOWED",
    "SYSTEMROOT",
  ]);
}

function expectCmdShimRuns(report: EnvironmentReport): void {
  // Only PATH was passed: the .cmd still starts, with cmd.exe taken from the system directory.
  expect(report.cmdShim.exitCode).toBe(0);
  expect(report.cmdShim.printedMarker).toBe(true);
  // Nothing from the host reaches it: PATH and SYSTEMROOT, plus the three names cmd.exe sets itself.
  expect(upper(report.cmdShim.names)).toEqual([
    "COMSPEC",
    "PATH",
    "PATHEXT",
    "PROMPT",
    "SYSTEMROOT",
  ]);
}

describe.skipIf(!windows)("windows command environment", () => {
  test("under node, only the caller's variables and SystemRoot reach the command", () => {
    expectCallerEnvironmentOnly(underNode());
  }, 150_000);

  test("under bun, only the caller's variables and SystemRoot reach the command", async () => {
    expectCallerEnvironmentOnly(await environmentReport(nodePath));
  }, 150_000);

  test("under node, a .cmd runs with only PATH in its environment", () => {
    expectCmdShimRuns(underNode());
  }, 150_000);

  test("under bun, a .cmd runs with only PATH in its environment", async () => {
    expectCmdShimRuns(await environmentReport(nodePath));
  }, 150_000);
});
