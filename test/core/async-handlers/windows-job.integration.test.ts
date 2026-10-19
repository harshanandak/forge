// [integration] Real Node processes exercise Windows Job ownership and descendant cleanup.
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

function nodeExecutable(): string {
  const executable = Bun.which("node");
  if (executable === null)
    throw new Error("Node is required for Windows Job integration tests.");
  return executable;
}

function runNode(program: string): string {
  const run = spawnSync(
    nodeExecutable(),
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
  return run.stdout;
}

type FixtureMode = "stop" | "parent-exit" | "owner-exit";

function runFixture(mode: FixtureMode): Outcome {
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
          detached: true,
          windowsHide: true,
        });
        child.unref();
        console.log("child:" + child.pid);
        if (${JSON.stringify(mode)} === "parent-exit") process.exit(0);
        setInterval(() => {}, 1000);
      });
    `;
  const program = `
      import { spawn } from "node:child_process";
      import { createInterface } from "node:readline";
      import { openWindowsJob } from ${JSON.stringify(entry)};

      if (process.versions.bun !== undefined) throw new Error("the fixture requires Node");
      for (let probe = 0; probe < 3; probe += 1) {
        const candidate = openWindowsJob({ cleanupTimeoutMs: 5000, pollIntervalMs: 25 });
        await candidate.stop();
        candidate.close();
        candidate.close();
      }

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
      if (${JSON.stringify(mode)} === "owner-exit") {
        console.log(JSON.stringify({
          helperPid: helper.pid,
          childPid,
          stopped: [],
          helperAlive: alive(helper.pid),
          childAlive: alive(childPid),
        }));
        process.exit(0);
      }
      if (${JSON.stringify(mode)} === "parent-exit") {
        await exited;
        if (!alive(childPid)) throw new Error("the detached descendant exited before cleanup");
      }
      let stopped;
      try {
        const firstStop = job.stop();
        if (job.stop() !== firstStop) throw new Error("stop was not idempotent");
        stopped = await firstStop;
      } finally {
        job.close();
        job.close();
      }
      await exited;
      console.log(JSON.stringify({
        helperPid: helper.pid,
        childPid,
        stopped,
        helperAlive: alive(helper.pid),
        childAlive: alive(childPid),
      }));
    `;

  return JSON.parse(runNode(program)) as Outcome;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pids: readonly number[]): Promise<void> {
  const deadline = performance.now() + 5000;
  while (pids.some(alive)) {
    if (performance.now() >= deadline) {
      throw new Error("processes survived release of their Windows Job owner");
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}

windowsTest(
  "a job attached before start contains and stops a helper and its detached descendant",
  () => {
    const outcome = runFixture("stop");
    expect(outcome.stopped).toContain(outcome.helperPid);
    expect(outcome.stopped).toContain(outcome.childPid);
    expect(outcome.helperAlive).toBe(false);
    expect(outcome.childAlive).toBe(false);
  },
  30_000,
);

windowsTest(
  "a job stops a detached descendant after its attached parent exits",
  () => {
    const outcome = runFixture("parent-exit");
    expect(outcome.stopped).toContain(outcome.childPid);
    expect(outcome.helperAlive).toBe(false);
    expect(outcome.childAlive).toBe(false);
  },
  30_000,
);

windowsTest(
  "exiting the Node job owner releases its handle and kills the contained tree",
  async () => {
    const outcome = runFixture("owner-exit");
    expect(outcome.helperAlive).toBe(true);
    expect(outcome.childAlive).toBe(true);
    await waitForExit([outcome.helperPid, outcome.childPid]);
    expect(alive(outcome.helperPid)).toBe(false);
    expect(alive(outcome.childPid)).toBe(false);
  },
  30_000,
);

windowsTest(
  "a failed native termination is typed and leaves the job available for release",
  () => {
    const entry = pathToFileURL(
      resolve(
        import.meta.dirname,
        "../../../src/adapters/process/windows-job.ts",
      ),
    ).href;
    const errors = pathToFileURL(
      resolve(import.meta.dirname, "../../../src/adapters/process/errors.ts"),
    ).href;
    const output = runNode(`
      import { createRequire } from "node:module";
      import { openWindowsJob } from ${JSON.stringify(entry)};
      import { ProcessSpawnError } from ${JSON.stringify(errors)};
      const koffi = createRequire(import.meta.url)("koffi");
      const load = koffi.load;
      let closes = 0;
      koffi.load = (...args) => {
        const library = load(...args);
        return {
          func(...definition) {
            const native = library.func(...definition);
            if (definition[1] === "TerminateJobObject") return () => 0;
            if (definition[1] === "CloseHandle") return (...args) => {
              const succeeded = native(...args);
              if (succeeded !== 0) closes += 1;
              return succeeded;
            };
            return native;
          },
        };
      };
      const job = openWindowsJob({ cleanupTimeoutMs: 5000, pollIntervalMs: 25 });
      let code;
      try {
        await job.stop();
        throw new Error("termination unexpectedly succeeded");
      } catch (error) {
        if (!(error instanceof ProcessSpawnError)) throw error;
        code = error.code;
      } finally {
        job.close();
        job.close();
      }
      console.log(JSON.stringify({ code, closes }));
    `);
    const outcome = JSON.parse(output) as {
      readonly code: string;
      readonly closes: number;
    };
    expect(outcome.code).toBe("TREE_KILL_FAILED");
    expect(outcome.closes).toBe(1);
  },
  30_000,
);
