// [integration] A real waiting helper must expire even if its host never sends start.
import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";

test("the native helper expires without receiving its start message", async () => {
  const node = Bun.which("node");
  if (node === null) throw Error("Node is required for supervisor integration");
  const helper = spawn(
    node,
    [
      resolve(
        import.meta.dirname,
        "../../../src/adapters/process/supervisor-child.ts",
      ),
      "100",
    ],
    {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      detached: process.platform !== "win32",
      windowsHide: true,
    },
  );
  const exited = once(helper, "exit");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      exited,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(Error("Waiting supervisor exceeded its declared lifetime")),
          3000,
        );
      }),
    ]);
    expect(helper.exitCode !== null || helper.signalCode !== null).toBe(true);
    assert.ok(helper.pid);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (helper.exitCode === null && helper.signalCode === null) {
      if (process.platform === "win32") helper.kill("SIGKILL");
      else if (helper.pid !== undefined) process.kill(-helper.pid, "SIGKILL");
    }
    helper.stderr?.destroy();
    if (helper.connected) helper.disconnect();
  }
}, 5000);
