import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as pause } from "node:timers/promises";
import { killTree } from "../../../src/adapters/process/tree-kill.ts";
import { linuxProcessTable } from "../../../src/adapters/process/linux-process-table.ts";
import { darwinProcessTable } from "../../../src/adapters/process/darwin-process-table.ts";

// The parent deliberately retains its exited child in a separate process group.
// It waits/reaps only after cleanup confirmation, independent of PID 1 behavior.
const parent = spawn(
  "python3",
  [
    "-c",
    `
import os, sys
pid = os.fork()
if pid == 0:
    os.setpgid(0, 0)
    os._exit(0)
print(pid, flush=True)
sys.stdin.readline()
os.waitpid(pid, 0)
print("reaped", flush=True)
`,
  ],
  { stdio: ["pipe", "pipe", "inherit"] },
);
const exited = once(parent, "exit");
const closed = once(parent, "close");
let output = "";
parent.stdout.on("data", (chunk: Buffer) => {
  output += chunk.toString();
});
const deadline = performance.now() + 5000;
async function until(check: () => boolean): Promise<void> {
  while (!check()) {
    if (performance.now() >= deadline)
      throw new Error("Zombie fixture did not settle");
    await pause(5);
  }
}
try {
  await until(() => output.includes("\n"));
  const pid = Number(output.split("\n")[0]);
  const state = (): string => {
    const table =
      process.platform === "darwin" ? darwinProcessTable : linuxProcessTable;
    for (const member of table.members(pid, () => {
      if (performance.now() >= deadline)
        throw new Error("Process inspection exceeded fixture deadline");
    })) {
      if (member.pid === pid) return member.state;
    }
    throw new Error("Retained child vanished before parent reaped it");
  };
  await until(() => state() === "Z");
  await killTree(
    pid,
    { cleanupTimeoutMs: 1000, pollIntervalMs: 10 },
    process.argv.includes("--without-process-table")
      ? {
          signal: (target, signal) => {
            process.kill(target, signal);
          },
          now: () => performance.now(),
          pause: async (ms) => {
            await pause(ms);
          },
        }
      : undefined,
  );
  const zombieStillUnreaped = state() === "Z";
  parent.stdin.end("reap\n");
  await exited;
  await closed;
  process.stdout.write(
    JSON.stringify({
      zombieStillUnreaped,
      reaped: output.includes("reaped"),
      code: parent.exitCode,
    }),
  );
} finally {
  if (parent.exitCode === null && parent.signalCode === null) {
    parent.stdin.end("reap\n");
    await exited;
    await closed;
  }
}
