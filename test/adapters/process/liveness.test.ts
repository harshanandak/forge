import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { isRunning } from "../../node-fixtures/process/liveness.ts";

test("a live process is running and a finished, collected one is not", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    stdio: "ignore",
  });
  const pid = child.pid as number;
  expect(isRunning(pid)).toBe(true);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
  expect(isRunning(pid)).toBe(false);
}, 30_000);

// Skipped on Windows, which has no zombies.
const zombieTest = process.platform === "win32" ? test.skip : test;

// A zombie exists only where an unreaped child can be left behind: the shell forks `true`, which
// exits at once, then becomes `sleep`, which never collects it.
zombieTest(
  "an exited child its parent never collected is a zombie and counts as not running",
  async () => {
    const parent = spawn("sh", ["-c", "true & echo $!; exec sleep 20"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    try {
      const pid = await new Promise<number>((resolve) => {
        parent.stdout.once("data", (chunk: Buffer) =>
          resolve(Number(chunk.toString().trim())),
        );
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      // The pid still exists (kill 0 succeeds) but nothing runs in it.
      expect(isRunning(pid)).toBe(false);
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      parent.kill("SIGKILL");
    }
  },
  30_000,
);
