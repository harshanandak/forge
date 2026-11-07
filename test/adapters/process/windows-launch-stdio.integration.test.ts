// [integration] The Windows launcher captures output, feeds stdin and reports the exit like the current path.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  expectedBytes,
  expectedInput,
  fixturePath,
  scenarios,
  type Scenarios,
} from "./windows-launch-stdio.fixture.ts";

const windows = process.platform === "win32";
const nodePath = windows ? (Bun.which("node") ?? "") : "";

let nodeRun: Scenarios | undefined;
function underNode(): Scenarios {
  if (nodeRun !== undefined) return nodeRun;
  const run = spawnSync(nodePath, [fixturePath, "run"], {
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (run.status !== 0)
    throw new Error(`node run failed: ${run.stderr || run.error?.message}`);
  nodeRun = JSON.parse(run.stdout) as Scenarios;
  return nodeRun;
}

let bunRun: Promise<Scenarios> | undefined;
function underBun(): Promise<Scenarios> {
  bunRun ??= scenarios(nodePath);
  return bunRun;
}

function expectParity(result: Scenarios): void {
  const { launched, current } = result.evidence;
  // The launcher's capture equals what the supervised path captured for the same child.
  expect(launched).toEqual(current);
  expect(launched.exitCode).toBe(7);
  expect(launched.truncated).toBe(true);
  expect(launched.evidence?.stdout.totalBytes).toBe(
    expectedBytes.stdout + "echo:".length + Buffer.byteLength(expectedInput),
  );
  expect(launched.evidence?.stderr.totalBytes).toBe(expectedBytes.stderr);
  expect(launched.evidence?.stdout.complete).toBe(true);
  // The child echoed its stdin, so the tail of stdout is the input.
  const tail = Buffer.from(
    launched.evidence?.stdout.tail ?? "",
    "base64",
  ).toString("utf8");
  expect(tail.endsWith(expectedInput)).toBe(true);
}

function expectCapped(result: Scenarios): void {
  const { launched, current } = result.capped;
  expect(launched).toEqual(current);
  expect(launched.truncated).toBe(true);
  expect(launched.stdout.length).toBe(1000);
  expect(launched.exitCode).toBe(7);
}

function expectMissing(result: Scenarios): void {
  expect(result.missing.length).toBe(2);
  for (const { launched, current } of result.missing) {
    expect(current).toEqual({ code: "SPAWN_FAILED", causeCode: "ENOENT" });
    expect(launched).toEqual(current);
  }
}

function expectQuiet(result: Scenarios): void {
  // The job is already empty after exit, so nothing was terminated or polled.
  expect(result.quiet).toEqual({ active: 0, terminations: 0 });
}

describe.skipIf(!windows)("windows launcher stdio", () => {
  test("under node, output, stdin and exit code equal the current path", () => {
    expectParity(underNode());
  }, 150_000);

  test("under bun, output, stdin and exit code equal the current path", async () => {
    expectParity(await underBun());
  }, 150_000);

  test("under node, output above the cap is truncated as today", () => {
    expectCapped(underNode());
  }, 150_000);

  test("under bun, output above the cap is truncated as today", async () => {
    expectCapped(await underBun());
  }, 150_000);

  test("under node, a missing executable gives SPAWN_FAILED with ENOENT", () => {
    expectMissing(underNode());
  }, 150_000);

  test("under bun, a missing executable gives SPAWN_FAILED with ENOENT", async () => {
    expectMissing(await underBun());
  }, 150_000);

  test("under node, stop after a clean exit terminates nothing", () => {
    expectQuiet(underNode());
  }, 150_000);

  test("under bun, stop after a clean exit terminates nothing", async () => {
    expectQuiet(await underBun());
  }, 150_000);
});
