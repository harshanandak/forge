import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";

const mode = process.argv[2]!;
const scenario = mode.replace("-deadline", "");
const windows = mode.startsWith("taskkill");
const timers: { callback: () => void; ms: number }[] = [];
Object.defineProperty(globalThis, "setTimeout", {
  value(callback: () => void, ms: number) {
    const timer = { callback, ms };
    timers.push(timer);
    return timer;
  },
});
Object.defineProperty(globalThis, "clearTimeout", { value: () => {} });
Object.defineProperty(process, "platform", {
  value: windows ? "win32" : "darwin",
});
let fallback = 0;
const child = Object.assign(new EventEmitter(), {
  pid: 12345,
  kill(signal: string) {
    assert.equal(signal, "SIGKILL");
    fallback++;
    if (mode.endsWith("exit")) child.emit("exit", null, "SIGKILL");
    return false;
  },
});
Object.defineProperty(childProcess, "spawn", { value: () => child });
const errno =
  scenario === "gone" ? "ESRCH" : scenario === "other" ? "EIO" : "EPERM";
Object.defineProperty(process, "kill", {
  value(pid: number, signal: NodeJS.Signals | number) {
    assert.equal(windows, false, "Windows must not signal POSIX groups");
    assert.equal(pid, -child.pid);
    assert.ok(signal === "SIGKILL" || signal === 0);
    throw Object.assign(new Error(`injected ${errno}`), { code: errno });
  },
});
let snapshots = 0;
let now = 0;
Object.defineProperty(performance, "now", { value: () => now });
Object.defineProperty(childProcess, "execFile", {
  value: Object.assign(() => {}, {
    [promisify.custom]: () => {
      snapshots++;
      now += 1000;
      if (scenario === "unknown")
        return Promise.reject(new Error("injected ps failure"));
      return Promise.resolve({
        stdout:
          scenario === "live" ? "12345 S\n12345 Z\n" : "12345 Z\n98765 S\n",
        stderr: "",
      });
    },
  }),
});
let taskkillOptions: { timeout?: number; killSignal?: string } | undefined;
Object.defineProperty(childProcess, "spawnSync", {
  value(command: string, args: string[], options: typeof taskkillOptions) {
    assert.equal(command, "taskkill");
    assert.deepEqual(args, ["/T", "/F", "/PID", "12345"]);
    taskkillOptions = options;
    return {
      status:
        mode === "taskkill-success" ? 0 : mode === "taskkill-status" ? 1 : null,
      error: mode.includes("enoent")
        ? Object.assign(new Error("missing taskkill"), { code: "ENOENT" })
        : mode === "taskkill-timeout"
          ? Object.assign(new Error("taskkill hung"), { code: "ETIMEDOUT" })
          : undefined,
    };
  },
});
syncBuiltinESMExports();
const { runWithin } = await import("../../../tools/pack-smoke/bounded.ts");
const signals = ["SIGINT", "SIGTERM"] as const;
const listeners = signals.map((signal) => process.listeners(signal));
let settled = false;
const pending = runWithin("journeys", "runner", [], {}, 2000).then(
  () => {
    settled = true;
    return undefined;
  },
  (error: unknown) => {
    settled = true;
    return error;
  },
);
if (!windows)
  for (const [index, signal] of signals.entries())
    assert.equal(process.listenerCount(signal), listeners[index]!.length + 1);
if (windows) {
  timers[0]!.callback();
  if (!mode.endsWith("exit")) {
    timers[1]?.callback();
  }
} else if (mode.endsWith("-deadline")) timers[0]!.callback();
else child.emit("exit", 0, null);
// A pending fake child has no OS handles: an unsettled await must fail the fixture.
await new Promise<void>((resolve) => setImmediate(resolve));
assert.ok(settled, "cleanup must settle without another child event");
const outcome = await pending;
for (const [index, signal] of signals.entries())
  assert.deepEqual(process.listeners(signal), listeners[index]);
if (windows) {
  assert.equal(snapshots, 0, "Windows must not inspect POSIX groups");
  assert.equal(taskkillOptions?.timeout, 5000);
  assert.equal(taskkillOptions.killSignal, "SIGKILL");
  assert.equal(fallback, mode === "taskkill-success" ? 0 : 1);
  assert.equal(timers.length, 2, "cleanup has its own settlement grace");
  assert.ok(timers[1]!.ms <= 1000);
  assert.ok(outcome instanceof Error);
  assert.match(outcome.message, /journeys/);
  assert.doesNotMatch(outcome.message, /its process tree was killed/);
  if (mode !== "taskkill-success") assert.match(outcome.message, /taskkill/);
} else if (scenario === "zombies" || scenario === "gone") {
  if (mode.endsWith("-deadline")) {
    assert.ok(outcome instanceof Error);
    assert.equal(
      outcome.message,
      "journeys timed out after 2000 ms; its process tree was killed",
    );
  } else assert.equal(outcome, undefined);
  assert.equal(snapshots, scenario === "gone" ? 0 : 1);
} else {
  assert.ok(outcome instanceof Error);
  assert.equal(outcome.message, "journeys: process group cleanup failed");
  if (scenario === "live") {
    assert.ok(outcome.cause instanceof Error);
    assert.equal(outcome.cause.message, "process group still running");
  }
  assert.equal(snapshots, scenario === "other" ? 0 : 1);
}
console.log(`PASS cleanup ${mode}`);
