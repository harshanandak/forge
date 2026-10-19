import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import {
  runChild,
  type ChildRunnerPort,
  type RunnerChild,
} from "../../../tools/child-runner.ts";

function harness(cleanupResolves = false) {
  const timers: Array<{
    ms: number;
    callback: () => void;
    cancelled: boolean;
  }> = [];
  let output: (
    stream: "stdout" | "stderr",
    value: Uint8Array,
  ) => void = () => {};
  let close: (
    status: number | null,
    signal: NodeJS.Signals | null,
  ) => void = () => {};
  let exit: (
    status: number | null,
    signal: NodeJS.Signals | null,
  ) => void = () => {};
  let error: (cause: Error) => void = () => {};
  let disposed = false;
  let stopped = 0;
  const child: RunnerChild = {
    onOutput(listener) {
      output = listener;
    },
    onClose(listener) {
      close = listener;
    },
    onExit(listener) {
      exit = listener;
    },
    onError(listener) {
      error = listener;
    },
    terminate() {
      stopped++;
      return cleanupResolves ? Promise.resolve() : new Promise(() => {});
    },
    dispose() {
      disposed = true;
    },
  };
  const port: ChildRunnerPort = {
    spawn: () => child,
    schedule(ms, callback) {
      const timer = { ms, callback, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  };
  return {
    port,
    timers,
    child,
    emit: (stream: "stdout" | "stderr", value: string) =>
      output(stream, Buffer.from(value)),
    close: (status = 0) => close(status, null),
    error: (cause: Error) => error(cause),
    exit: () => exit(0, null),
    stopped: () => stopped,
    disposed: () => disposed,
  };
}
const options = {
  cwd: ".",
  timeoutMs: 100,
  cleanupTimeoutMs: 10,
  maxOutputBytes: 8,
  onOutput() {},
};

test("the deadline settles even when exit, pipe close and tree cleanup never settle", async () => {
  const fake = harness();
  const pending = runChild("stuck fixture", "fake", [], options, fake.port);
  fake.emit("stdout", "old output LAST");
  fake.emit("stderr", "last err");
  fake.timers[0]!.callback();
  expect(fake.stopped()).toBe(1);
  expect(fake.timers[1]!.ms).toBe(10);
  fake.timers[1]!.callback();
  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CHILD_TIMEOUT" &&
      error.message.includes("stuck fixture") &&
      error.message.includes("put LAST") &&
      error.message.includes("last err"),
  );
  expect(fake.disposed()).toBe(true);
}, 5000);

test("an exited child whose descendant keeps pipes open still reaches its deadline", async () => {
  const fake = harness();
  const pending = runChild("held pipe", "fake", [], options, fake.port);
  fake.exit();
  fake.timers[0]!.callback();
  fake.timers[1]!.callback();
  await assert.rejects(pending, { code: "CHILD_TIMEOUT" });
  expect(fake.stopped()).toBe(1);
}, 5000);

test("normal output is streamed and bounded while completed children clear timers", async () => {
  const fake = harness(true);
  const streamed: string[] = [];
  const pending = runChild(
    "normal",
    "fake",
    [],
    { ...options, onOutput: (_stream, value) => streamed.push(value) },
    fake.port,
  );
  fake.emit("stdout", "hello");
  fake.emit("stdout", " world");
  fake.close();
  expect(await pending).toMatchObject({
    stdout: "lo world",
    stderr: "",
    status: 0,
  });
  expect(streamed).toEqual(["hello", " world"]);
  expect(fake.timers[0]!.cancelled).toBe(true);
}, 5000);

test("cancellation refuses to spawn and includes the child name", async () => {
  const fake = harness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runChild(
      "cancelled child",
      "fake",
      [],
      { ...options, signal: controller.signal },
      fake.port,
    ),
    { code: "CHILD_CANCELLED" },
  );
  expect(fake.timers).toEqual([]);
}, 5000);

test("declared deadline and output bounds cannot disable supervision", () => {
  for (const override of [
    { timeoutMs: 0 },
    { timeoutMs: Infinity },
    { cleanupTimeoutMs: 60_001 },
    { maxOutputBytes: 0 },
  ]) {
    expect(() =>
      runChild(
        "invalid",
        "fake",
        [],
        { ...options, ...override },
        harness().port,
      ),
    ).toThrow(RangeError);
  }
}, 5000);

test("counterfactual commands may return declared nonzero exits without masking deadlines", async () => {
  const fake = harness(true);
  const pending = runChild(
    "expected failure",
    "fake",
    [],
    { ...options, acceptableExitCodes: null },
    fake.port,
  );
  fake.close(7);
  expect((await pending).status).toBe(7);
}, 5000);

test("spawn errors preserve errno and still have bounded cleanup", async () => {
  const fake = harness(true);
  const pending = runChild(
    "missing executable",
    "fake",
    [],
    options,
    fake.port,
  );
  fake.error(Object.assign(new Error("not installed"), { code: "ENOENT" }));
  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof Error &&
      error.cause instanceof Error &&
      "code" in error.cause &&
      error.cause.code === "ENOENT",
  );
}, 5000);

test("a normally closed child cannot hide cleanup that never settles", async () => {
  const fake = harness();
  const pending = runChild("cleanup stuck", "fake", [], options, fake.port);
  fake.close();
  fake.timers[1]!.callback();
  await assert.rejects(pending, { code: "CHILD_CLEANUP_FAILED" });
  expect(fake.disposed()).toBe(true);
}, 5000);

test("nested runners explicitly inherit the outer step group without forming a new group", async () => {
  const fake = harness(true);
  const inherited: unknown[] = [];
  const port: ChildRunnerPort = {
    ...fake.port,
    spawn: (_command, _args, spawnOptions) => {
      inherited.push(
        "inheritProcessGroup" in spawnOptions
          ? spawnOptions.inheritProcessGroup
          : undefined,
      );
      return fake.child;
    },
  };
  const pending = runChild(
    "nested child",
    "fake",
    [],
    { ...options, inheritProcessGroup: true },
    port,
  );
  fake.close();
  await pending;
  expect(inherited).toEqual([true]);
}, 5000);
