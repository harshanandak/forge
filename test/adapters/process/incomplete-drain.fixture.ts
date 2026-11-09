// Isolate transport faults so module mocks cannot affect other process tests.
import { mock } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { stopCaptured } from "../../../src/adapters/process/windows-launch-stdio.ts";

let held = "";
const complete = (name: string): boolean => held !== name && held !== "both";
const job = {
  activeCount: () => 0,
  members: () => [123],
  close: () => undefined,
};
await mock.module("../../../src/adapters/process/windows-job.ts", () => ({
  openWindowsJob: () => job,
}));
const drain = stopCaptured;
await mock.module(
  "../../../src/adapters/process/windows-launch-stdio.ts",
  () => ({
    stopCaptured: drain,
    launchCaptured: () =>
      Promise.resolve({
        pid: 123,
        exited: Promise.resolve(0),
        drained: held ? new Promise<void>(() => undefined) : Promise.resolve(),
        dispose: () => undefined,
      }),
  }),
);
await mock.module("node:child_process", () => ({
  spawn: () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 123,
      exitCode: 0,
      signalCode: null,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    queueMicrotask(() => {
      for (const name of ["stdout", "stderr"] as const)
        if (complete(name)) child[name].end();
      child.emit("exit", 0, null);
      if (!held) setImmediate(() => child.emit("close"));
    });
    return child;
  },
}));
Object.defineProperty(process, "kill", {
  value: () => {
    throw Object.assign(new Error("group gone"), { code: "ESRCH" });
  },
});
// Select the event backend even though this isolated fixture runs in the native runtime.
Reflect.deleteProperty(process.versions, "bun");
if (process.versions.bun !== undefined)
  throw new Error("Event backend not selected");
const { runProcessTree } =
  await import("../../../src/adapters/process/process-tree.ts");
const { runBunProcessTree } =
  await import("../../../src/adapters/process/bun-process-tree.ts");
const { runProcess } = await import("../../../src/adapters/process/run.ts");
Object.defineProperty(Bun, "spawn", {
  value: () => ({
    pid: 123,
    exitCode: 0,
    signalCode: null,
    exited: Promise.resolve(0),
    ...Object.fromEntries(
      ["stdout", "stderr"].map((name) => [
        name,
        new ReadableStream<Uint8Array>({
          start(controller) {
            if (complete(name)) controller.close();
          },
        }),
      ]),
    ),
  }),
});
const supervision = {
  cleanupTimeoutMs: 100,
  pollIntervalMs: 1,
  drainTimeoutMs: 50,
  maxConcurrent: 1,
};
const plan = { file: "fixture.exe", args: [], windowsVerbatimArguments: false };
const results = [];
const backend = process.argv[2];
for (const capture of [false, true])
  for (held of ["", "stdout", "stderr", "both"]) {
    const options = {
      cwd: import.meta.dirname,
      env: {},
      timeoutMs: 5000,
      maxOutputBytes: 64,
      ...(capture ? { capture: { headBytes: 32, tailBytes: 32 } } : {}),
    };
    const started = performance.now();
    const result =
      backend === "job"
        ? await runProcess(plan.file, [], options, "win32", { supervision })
        : await (backend === "event" ? runProcessTree : runBunProcessTree)(
            plan,
            options,
            supervision,
            started,
          );
    results.push({ backend, capture, held, result });
  }
console.log(JSON.stringify(results));
