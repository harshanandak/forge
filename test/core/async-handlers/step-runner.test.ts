import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import type { ChildRunnerPort } from "../../../tools/child-runner.ts";
import { runStep } from "../../../tools/step-runner.ts";
import { validateRunnerPolicy } from "../../../tools/runner-policy.ts";

test("a hard step deadline cancels every stuck child and drains only bounded cleanup", async () => {
  const timers: { ms: number; fire: () => void; cancelled: boolean }[] = [];
  const stopped: string[] = [];
  const disposed: string[] = [];
  const output: [string, string][] = [];
  const port: ChildRunnerPort = {
    schedule(ms, fire) {
      const timer = { ms, fire, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    spawn: (command, _args, options) => {
      expect(options.env?.FORGE_RUNNER_GROUP_SCOPE).toBe("inherited");
      return {
        onOutput(listener) {
          listener("stdout", Buffer.from(`${command} last output`));
        },
        onExit() {},
        onClose() {},
        onError() {},
        terminate() {
          stopped.push(command);
          return new Promise(() => {});
        },
        dispose() {
          disposed.push(command);
        },
      };
    },
  };
  const pending = runStep(
    [
      { label: "pack smoke", executable: "pack", args: [] },
      { label: "integration-rest", executable: "tests", args: [] },
    ],
    ".",
    {},
    {
      childTimeoutMs: 100,
      stepTimeoutMs: 100,
      cleanupTimeoutMs: 10,
      maxOutputBytes: 100,
    },
    port,
    (stream, value) => output.push([stream, value]),
  );
  expect(output).toEqual([
    ["stdout", "pack last output"],
    ["stdout", "tests last output"],
  ]);
  timers[0]!.fire();
  expect(stopped).toEqual(["pack", "tests"]);
  for (const timer of timers) if (timer.ms === 10) timer.fire();
  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof AggregateError &&
      error.message.includes("step deadline exceeded") &&
      error.errors.length === 2 &&
      error.errors.every(
        (item: unknown) =>
          item instanceof Error && item.message.includes("last output"),
      ),
  );
  expect(disposed).toEqual(["pack", "tests"]);
  expect(timers[0]!.cancelled).toBe(true);
}, 5000);

test("runner policy validates declared safety bounds without changing test-case timeouts", () => {
  const policy = {
    childTimeoutMs: 180000,
    stepTimeoutMs: 300000,
    cleanupTimeoutMs: 5000,
    maxOutputBytes: 1048576,
  };
  expect(validateRunnerPolicy(policy)).toEqual(policy);
  for (const value of [
    null,
    [],
    {},
    { ...policy, extra: 1 },
    { ...policy, childTimeoutMs: 0 },
    { ...policy, childTimeoutMs: 600001 },
    { ...policy, stepTimeoutMs: 600001 },
    { ...policy, cleanupTimeoutMs: 60001 },
    { ...policy, maxOutputBytes: 16777217 },
    { ...policy, childTimeoutMs: 300001 },
    { ...policy, childTimeoutMs: NaN },
  ])
    expect(() => validateRunnerPolicy(value)).toThrow();
}, 5000);
