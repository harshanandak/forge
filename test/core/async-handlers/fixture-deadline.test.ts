import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import {
  awaitDeadline,
  closeChild,
  type FixtureClock,
} from "../../node-fixtures/async-handlers/deadline.mjs";

function fakeClock() {
  const callbacks = new Map<number, () => void>();
  let next = 0;
  const delays: number[] = [];
  const clock: FixtureClock = {
    set(delay, callback) {
      delays.push(delay);
      callbacks.set(++next, callback);
      return next;
    },
    clear(handle) {
      callbacks.delete(handle as number);
    },
  };
  return {
    clock,
    callbacks,
    delays,
    fire() {
      const entry = callbacks.entries().next().value;
      if (!entry) throw new Error("No pending deadline");
      callbacks.delete(entry[0]);
      entry[1]();
    },
  };
}

test("fixture deadlines name the stuck child and its final output without waiting for wall time", async () => {
  const time = fakeClock();
  const pending = awaitDeadline(
    new Promise<void>(() => {}),
    5000,
    "MCP shutdown",
    { clock: time.clock, details: () => "last stderr" },
  );
  time.fire();
  await assert.rejects(
    pending,
    /MCP shutdown exceeded 5000 ms; last output: last stderr/,
  );
  expect(time.delays).toEqual([5000]);
  expect(time.callbacks.size).toBe(0);
}, 5000);

test("settlement clears the watchdog and an already-exited child never waits", async () => {
  const time = fakeClock();
  expect(
    await awaitDeadline(Promise.resolve("done"), 5000, "fixture", {
      clock: time.clock,
    }),
  ).toBe("done");
  expect(time.callbacks.size).toBe(0);
  let ended = false;
  const child = {
    stdin: {
      end() {
        ended = true;
      },
      destroy() {},
    },
    stdout: null,
    stderr: null,
    exitCode: 0,
    signalCode: null,
    kill() {
      throw new Error("Already exited");
    },
  };
  await closeChild(
    child,
    new Promise(() => {}),
    5000,
    "MCP",
    () => "",
    time.clock,
  );
  expect(ended).toBe(true);
  expect(time.delays).toEqual([5000]);
}, 5000);

test("a non-exiting child is killed and reaped under a second bounded deadline", async () => {
  const time = fakeClock();
  let reap: (() => void) | undefined;
  const exited = new Promise<void>((resolve) => {
    reap = resolve;
  });
  const signals: string[] = [];
  const child = {
    stdin: null,
    stdout: null,
    stderr: null,
    exitCode: null,
    signalCode: null,
    kill(signal: string) {
      signals.push(signal);
      reap?.();
      return true;
    },
  };
  const pending = closeChild(
    child,
    exited,
    5000,
    "MCP shutdown",
    () => "last output",
    time.clock,
  );
  time.fire();
  await assert.rejects(pending, /MCP shutdown exceeded/);
  expect(signals).toEqual(["SIGKILL"]);
  expect(time.delays).toEqual([5000, 5000]);
  expect(time.callbacks.size).toBe(0);
}, 5000);

test("even a missing exit notification after SIGKILL cannot strand fixture cleanup", async () => {
  const time = fakeClock();
  const child = {
    stdin: null,
    stdout: null,
    stderr: null,
    exitCode: null,
    signalCode: null,
    kill() {
      return true;
    },
  };
  const pending = closeChild(
    child,
    new Promise(() => {}),
    5000,
    "MCP shutdown",
    () => "",
    time.clock,
  );
  time.fire();
  for (let turn = 0; turn < 8 && time.callbacks.size === 0; turn++)
    await Promise.resolve();
  time.fire();
  await assert.rejects(pending, /MCP shutdown after SIGKILL exceeded/);
  expect(time.callbacks.size).toBe(0);
}, 5000);
