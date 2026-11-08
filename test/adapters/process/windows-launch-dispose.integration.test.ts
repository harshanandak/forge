// [integration] A process-handle release that throws cannot leave a launch's promises pending.
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { planSpawn } from "../../../src/adapters/process/plan.ts";
import { openWindowsJob } from "../../../src/adapters/process/windows-job.ts";
import { closeLaunchedProcess } from "../../../src/adapters/process/windows-launch.ts";
import {
  launchCapturedWith,
  type CapturedLaunch,
} from "../../../src/adapters/process/windows-launch-stdio.ts";

const windows = process.platform === "win32";

/** "pending" when the promise has not settled within `ms`; otherwise how it settled. */
function settledWithin(promise: Promise<unknown>, ms: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.then(
      () => "resolved",
      (error: { code?: string }) => error.code ?? "rejected",
    ),
    new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve("pending"), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

describe.skipIf(!windows)("windows launch dispose", () => {
  test("dispose settles exited and drained even when releasing the process handle throws", async () => {
    const node = Bun.which("node");
    if (node === null) throw new Error("Node is required for this launch.");
    const env = { SystemRoot: process.env.SystemRoot ?? "C:/Windows" };
    const job = openWindowsJob({ cleanupTimeoutMs: 5000, pollIntervalMs: 25 });
    let launch: CapturedLaunch | undefined;
    try {
      launch = await launchCapturedWith(
        planSpawn(node, ["-e", "setInterval(() => {}, 1000)"], env, "win32"),
        job,
        {
          cwd: tmpdir(),
          env,
          pollIntervalMs: 25,
          onStdout: () => undefined,
          onStderr: () => undefined,
        },
        {
          // The handle really closes, so the test leaks nothing; the release then reports failure.
          closeProcess: (launched) => {
            closeLaunchedProcess(launched);
            throw new Error("release failed");
          },
        },
      );
      expect(() => launch?.dispose()).toThrow("release failed");
      expect(await settledWithin(launch.exited, 2_000)).toBe("SPAWN_FAILED");
      expect(await settledWithin(launch.drained, 2_000)).toBe("SPAWN_FAILED");
      // A retry after the failed release has nothing left to do.
      expect(() => launch?.dispose()).not.toThrow();
    } finally {
      try {
        await job.stop();
      } finally {
        job.close();
      }
    }
  }, 150_000);
});
