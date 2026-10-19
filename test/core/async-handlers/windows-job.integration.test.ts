// [integration] A Node helper is attached before it may spawn, then the real Windows job stops both processes.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface Outcome {
  readonly helperPid: number;
  readonly childPid: number;
  readonly stopped: readonly number[];
  readonly helperAlive: boolean;
  readonly childAlive: boolean;
}

const windowsTest = process.platform === "win32" ? test : test.skip;

windowsTest(
  "a job attached before start contains and stops a helper and its descendant",
  () => {
    const entry = pathToFileURL(
      resolve(
        import.meta.dirname,
        "../../../src/adapters/process/windows-job.ts",
      ),
    ).href;
    const helperProgram = String.raw`
      const { spawn } = require("node:child_process");
      console.log("ready");
      process.stdin.once("data", () => {
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          stdio: "ignore",
          windowsHide: true,
        });
        console.log("child:" + child.pid);
        setInterval(() => {}, 1000);
      });
    `;
    const program = `
      import { spawn } from "node:child_process";
      import { createInterface } from "node:readline";
      import { openWindowsJob } from ${JSON.stringify(entry)};

      const alive = (pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      const job = openWindowsJob({ cleanupTimeoutMs: 5000, pollIntervalMs: 25 });
      const helper = spawn(process.execPath, ["-e", ${JSON.stringify(helperProgram)}], {
        stdio: ["pipe", "pipe", "inherit"],
        windowsHide: true,
      });
      const exited = new Promise((resolveExit) => helper.once("exit", resolveExit));
      const lines = createInterface({ input: helper.stdout })[Symbol.asyncIterator]();
      const ready = await lines.next();
      if (ready.value !== "ready" || helper.pid === undefined) {
        throw new Error("the helper did not become ready");
      }
      job.attach(helper.pid);
      helper.stdin.end("start\\n");
      const childLine = await lines.next();
      const childPid = Number(childLine.value?.replace("child:", ""));
      if (!Number.isInteger(childPid) || childPid <= 0) {
        throw new Error("the helper did not report its descendant");
      }
      const stopped = await job.stop();
      job.close();
      job.close();
      await exited;
      console.log(JSON.stringify({
        helperPid: helper.pid,
        childPid,
        stopped,
        helperAlive: alive(helper.pid),
        childAlive: alive(childPid),
      }));
    `;

    const run = spawnSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--input-type=module",
        "--eval",
        program,
      ],
      { encoding: "utf8", timeout: 20_000, windowsHide: true },
    );
    if (run.status !== 0) {
      throw new Error(
        `the Windows job fixture failed (${run.status}): ${run.stderr || run.error?.message}`,
      );
    }
    const outcome = JSON.parse(run.stdout) as Outcome;
    expect(outcome.stopped).toContain(outcome.helperPid);
    expect(outcome.stopped).toContain(outcome.childPid);
    expect(outcome.helperAlive).toBe(false);
    expect(outcome.childAlive).toBe(false);
  },
  30_000,
);
