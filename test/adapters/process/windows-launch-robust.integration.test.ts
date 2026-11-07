// [integration] The Windows launcher's captured path holds up on large stdin, big exit codes, descendants and teardown.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  fixturePath,
  robustScenarios,
  type RobustReport,
} from "./windows-launch-robust.fixture.ts";

const windows = process.platform === "win32";
const nodePath = windows ? (Bun.which("node") ?? "") : "";

let nodeRun: RobustReport | undefined;
function underNode(): RobustReport {
  if (nodeRun !== undefined) return nodeRun;
  const run = spawnSync(nodePath, [fixturePath, "run"], {
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (run.status !== 0)
    throw new Error(`node run failed: ${run.stderr || run.error?.message}`);
  nodeRun = JSON.parse(run.stdout) as RobustReport;
  return nodeRun;
}

let bunRun: Promise<RobustReport> | undefined;
function underBun(): Promise<RobustReport> {
  bunRun ??= robustScenarios(nodePath);
  return bunRun;
}

function expectInput(report: RobustReport): void {
  // 256 KiB is four times the pipe buffer, so the write needs the command to read as it goes.
  expect(report.bigStdin.exitCode).toBe(0);
  expect(report.bigStdin.echoedBytes).toBe(256 * 1024);
  expect(report.bigStdin.echoedSha256).toBe(report.bigStdin.inputSha256);
  // A command that never reads 1 MiB of stdin still ends cleanly and does not hang the run.
  expect(report.unreadStdin.exitCode).toBe(0);
}

function expectExitCode(report: RobustReport): void {
  expect(report.bigExit.exitCode).toBe(300);
}

function expectLingering(report: RobustReport): void {
  // The command exited while a detached descendant held stdout: the stop ends the descendant,
  // which closes the pipe, so nothing waits for the host timeout.
  expect(report.lingering.exitCode).toBe(0);
  expect(report.lingering.descendantStopped).toBe(true);
  expect(report.lingering.descendantGone).toBe(true);
  expect(report.lingering.pipesClosed).toBe(true);
}

function expectDisposed(report: RobustReport): void {
  for (const entry of report.disposed) {
    expect(entry.exited, `exited ${entry.when}`).toBe("SPAWN_FAILED");
    expect(entry.drained, `drained ${entry.when}`).toBe("SPAWN_FAILED");
  }
}

function expectAttachFailure(report: RobustReport): void {
  expect(report.attachFailure.message).toBe("injected attach failure");
  expect(report.attachFailure.jobEmptied).toBe(true);
}

function expectForeignServer(report: RobustReport): void {
  // Another process hosts the pipe: the launch is refused, nothing starts, no byte reaches it.
  expect(report.foreignServer.code).toBe("SPAWN_FAILED");
  expect(report.foreignServer.message).toContain("not served by this process");
  expect(report.foreignServer.started).toBe(false);
  expect(report.foreignServer.serverReceivedBytes).toBe(0);
}

describe.skipIf(!windows)("windows launcher edge cases", () => {
  test("under node, large stdin round-trips and an unread stdin does not hang", () => {
    expectInput(underNode());
  }, 150_000);

  test("under bun, large stdin round-trips and an unread stdin does not hang", async () => {
    expectInput(await underBun());
  }, 150_000);

  test("under node, an exit code above 255 is reported whole", () => {
    expectExitCode(underNode());
  }, 150_000);

  test("under bun, an exit code above 255 is reported whole", async () => {
    expectExitCode(await underBun());
  }, 150_000);

  test("under node, a descendant holding stdout does not outlast the stop", () => {
    expectLingering(underNode());
  }, 150_000);

  test("under bun, a descendant holding stdout does not outlast the stop", async () => {
    expectLingering(await underBun());
  }, 150_000);

  test("under node, dispose settles exited and drained with a typed error", () => {
    expectDisposed(underNode());
  }, 150_000);

  test("under bun, dispose settles exited and drained with a typed error", async () => {
    expectDisposed(await underBun());
  }, 150_000);

  test("under node, a failure after launch ends the command", () => {
    expectAttachFailure(underNode());
  }, 150_000);

  test("under bun, a failure after launch ends the command", async () => {
    expectAttachFailure(await underBun());
  }, 150_000);

  test("under node, a pipe served by another process is refused before any byte is sent", () => {
    expectForeignServer(underNode());
  }, 150_000);

  test("under bun, a pipe served by another process is refused before any byte is sent", async () => {
    expectForeignServer(await underBun());
  }, 150_000);
});
