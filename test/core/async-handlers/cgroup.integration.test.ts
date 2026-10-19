// [integration] A real Linux cgroup is used when the host delegates a writable v2 subtree.
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import {
  openLinuxCgroup,
  probeLinuxCgroup,
} from "../../../src/adapters/process/cgroup.ts";
import { ProcessSpawnError } from "../../../src/adapters/process/errors.ts";

const timing = { cleanupTimeoutMs: 5_000, pollIntervalMs: 25 };

test("cgroup supervision timings require bounded integer configuration", () => {
  const invalid = [
    { cleanupTimeoutMs: 0, pollIntervalMs: 1 },
    { cleanupTimeoutMs: 60_001, pollIntervalMs: 1 },
    { cleanupTimeoutMs: 1.5, pollIntervalMs: 1 },
    { cleanupTimeoutMs: 1, pollIntervalMs: 0 },
    { cleanupTimeoutMs: 5_000, pollIntervalMs: 1_001 },
    { cleanupTimeoutMs: 5_000, pollIntervalMs: 1.5 },
    { cleanupTimeoutMs: 1, pollIntervalMs: 2 },
    { cleanupTimeoutMs: Number.NaN, pollIntervalMs: 1 },
    { cleanupTimeoutMs: 5_000, pollIntervalMs: Number.POSITIVE_INFINITY },
  ];
  for (const options of invalid) {
    for (const operation of [openLinuxCgroup, probeLinuxCgroup]) {
      let failure: unknown;
      try {
        operation(options);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ProcessSpawnError);
      expect((failure as ProcessSpawnError).code).toBe("INVALID_OPTIONS");
    }
  }
}, 10_000);

test("unsupported hosts refuse cgroup containment before a process is spawned", () => {
  const capability = probeLinuxCgroup(timing);
  if (process.platform === "linux" && capability.available) return;

  expect(capability.available).toBe(false);
  expect(capability.reason).toBeString();
  let failure: unknown;
  try {
    openLinuxCgroup(timing);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ProcessSpawnError);
  expect((failure as ProcessSpawnError).code).toBe("CONTAINMENT_UNAVAILABLE");
}, 10_000);

test("a delegated Linux cgroup contains a helper before it creates a descendant", async () => {
  const capability = probeLinuxCgroup(timing);
  if (!capability.available) {
    expect(capability.reason).toBeString();
    console.log(
      `NOT_EXERCISED: Linux cgroup enforcement: ${capability.reason}`,
    );
    return;
  }

  const group = openLinuxCgroup(timing);
  const program = `
    const { spawn } = require("node:child_process");
    console.log("ready");
    process.stdin.once("data", () => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      console.log(child.pid);
      setInterval(() => {}, 1000);
    });
  `;
  const child = spawn(process.execPath, ["-e", program], {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  const pid = child.pid;
  if (pid === undefined) {
    child.kill("SIGKILL");
    group.close();
    throw new Error("Node did not assign a process id");
  }

  const closed = once(child, "close");
  const lines = createInterface({ input: child.stdout });
  try {
    const output = lines[Symbol.asyncIterator]();
    expect((await output.next()).value).toBe("ready");
    group.attach(pid);
    child.stdin.end("start\n");
    const descendant = Number((await output.next()).value);
    expect(Number.isSafeInteger(descendant) && descendant > 0).toBe(true);
    const stopped = await group.stop();
    expect(stopped).toContain(pid);
    expect(stopped).toContain(descendant);
    await closed;
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    try {
      await group.stop();
    } catch {
      // Preserve the primary assertion; close below still proves the group is empty.
    }
    group.close();
  }
}, 15_000);
