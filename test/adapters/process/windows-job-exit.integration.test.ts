// [integration] A killed process counts as exited only once its process object is signaled.
import { expect, setDefaultTimeout, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  openWindowsJob,
  waitForExit,
  windowsProcessStartTime,
} from "../../../src/adapters/process/windows-job.ts";

const windows = process.platform === "win32";

// The guard reads a file default, not the timeout after a skipIf call; the test also passes its own.
setDefaultTimeout(30_000);

test.skipIf(!windows)(
  "waitForExit signals for a job-killed process and names one that is still running",
  async () => {
    const job = openWindowsJob({ cleanupTimeoutMs: 5_000, pollIntervalMs: 10 });
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        stdio: "ignore",
        windowsHide: true,
      },
    );
    const pid = child.pid!;
    try {
      job.attach(pid);
      const target = { pid, started: windowsProcessStartTime(pid) };
      expect(target.started).toBeDefined();
      // Still running: the deadline passes and the error names the pid.
      await expect(waitForExit([target], { deadlineMs: 150 })).rejects.toThrow(
        `still running 150 ms after their job ended: ${pid}.`,
      );
      await job.stop();
      expect(await waitForExit([target], { deadlineMs: 5_000 })).toEqual([
        { pid, state: "signaled" },
      ]);
    } finally {
      child.kill();
      job.close();
    }
  },
  30_000,
);
