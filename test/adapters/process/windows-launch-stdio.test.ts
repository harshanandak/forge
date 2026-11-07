import { expect, test } from "bun:test";
import {
  stopAfterExit,
  stopCaptured,
} from "../../../src/adapters/process/windows-launch-stdio.ts";
import type { WindowsJob } from "../../../src/adapters/process/windows-job.ts";

interface FakeJob extends WindowsJob {
  readonly stops: () => number;
}

function fakeJob(active: () => number): FakeJob {
  let stops = 0;
  return {
    attach: () => undefined,
    members: () => [11, 12],
    activeCount: active,
    terminations: () => stops,
    stop: () => {
      stops += 1;
      return Promise.resolve([11, 12, 13]);
    },
    close: () => undefined,
    stops: () => stops,
  };
}

test("a job with no running process is not stopped after the command exits", async () => {
  const job = fakeJob(() => 0);
  expect(await stopAfterExit(job)).toEqual({
    stopped: [11, 12],
    skipped: true,
  });
  expect(job.stops()).toBe(0);
}, 5_000);

test("a job that still runs something is stopped after the command exits", async () => {
  const job = fakeJob(() => 2);
  expect(await stopAfterExit(job)).toEqual({
    stopped: [11, 12, 13],
    skipped: false,
  });
  expect(job.stops()).toBe(1);
}, 5_000);

test("a failed active-count query falls through to the full stop", async () => {
  const job = fakeJob(() => {
    throw new Error("QueryInformationJobObject failed");
  });
  expect(await stopAfterExit(job)).toEqual({
    stopped: [11, 12, 13],
    skipped: false,
  });
  expect(job.stops()).toBe(1);
}, 5_000);

test("output that never drains is reported as not closed after the drain timeout", async () => {
  const job = fakeJob(() => 0);
  const started = performance.now();
  const stopped = await stopCaptured(
    { drained: new Promise<void>(() => undefined) },
    job,
    { drainTimeoutMs: 50, commandExited: true },
  );
  expect(stopped.pipesClosed).toBe(false);
  expect(performance.now() - started).toBeLessThan(2_000);
}, 5_000);

test("output that drained in time is reported as closed", async () => {
  const stopped = await stopCaptured(
    { drained: Promise.resolve() },
    fakeJob(() => 0),
    { drainTimeoutMs: 50, commandExited: true },
  );
  expect(stopped).toEqual({
    stopped: [11, 12],
    skipped: true,
    pipesClosed: true,
  });
}, 5_000);

test("a timeout or cancel always runs the full stop, even with nothing running", async () => {
  const job = fakeJob(() => 0);
  const stopped = await stopCaptured({ drained: Promise.resolve() }, job, {
    drainTimeoutMs: 50,
    commandExited: false,
  });
  expect(stopped.skipped).toBe(false);
  expect(job.stops()).toBe(1);
}, 5_000);

test("a failed capture rejects instead of looking complete", async () => {
  const failure = new Error("capture failed");
  await expect(
    stopCaptured(
      { drained: Promise.reject(failure) },
      fakeJob(() => 0),
      {
        drainTimeoutMs: 50,
        commandExited: true,
      },
    ),
  ).rejects.toBe(failure);
}, 5_000);
