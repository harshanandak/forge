import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { Duplex } from "node:stream";
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

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// A zombie exists only where an unreaped child can be left behind. The shell forks a child that
// blocks on fd 3, then becomes `cat`, which never collects it. A shell reaps its own children as they
// exit, so the child must not exit until the shell has become `cat`: `cat` echoing a line back proves
// it, and only then is the child released. Every step waits on something observable, never on time.
zombieTest(
  "an exited child its parent never collected is a zombie and counts as not running",
  async () => {
    const parent = spawn("sh", ["-c", "{ read _ <&3; } & echo $!; exec cat"], {
      stdio: ["pipe", "pipe", "ignore", "pipe"],
    });
    try {
      const { stdin, stdout } = parent;
      const release = parent.stdio[3];
      if (!stdin || !stdout || !(release instanceof Duplex)) {
        throw new Error("the shell's pipes were not opened");
      }
      let output = "";
      stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      await until(() => output.includes("\n"), "the child's pid");
      const pid = Number(output.split("\n")[0]);
      stdin.write("exec\n");
      await until(() => output.includes("exec\n"), "the shell to become cat");
      release.write("go\n");
      // The child exits and nothing collects it: the pid stays, but nothing runs in it.
      await until(() => !isRunning(pid), "the child to exit");
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      parent.kill("SIGKILL");
    }
  },
  30_000,
);
