import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import {
  createLivenessProbe,
  waitUntilGone,
} from "../../node-fixtures/process/liveness.ts";

const port = {
  platform: "darwin",
  probe(_pid: number): void {},
  readStat(_pid: number): string {
    return "123 (name with ) brackets) Z 1 123";
  },
  inspect(
    _pid: number,
    _options: {
      readonly timeout: number;
      readonly killSignal: "SIGKILL";
      readonly maxBuffer: number;
    },
  ) {
    return { stdout: "S\n", status: 0, error: undefined as Error | undefined };
  },
};

test("Darwin liveness inspection has a hard kill deadline and bounded output", () => {
  const running = createLivenessProbe({
    ...port,
    inspect(pid, options) {
      expect(pid).toBe(123);
      expect(options).toEqual({
        timeout: 1000,
        killSignal: "SIGKILL",
        maxBuffer: 4096,
      });
      return { stdout: "Z\n", status: 0 };
    },
  });
  expect(running(123)).toBe(false);
}, 5000);

test("inspection timeout and permission errors fail loudly instead of proving termination", () => {
  const timedOut = Object.assign(new Error("inspection timed out"), {
    code: "ETIMEDOUT",
  });
  const running = createLivenessProbe({
    ...port,
    inspect() {
      return { stdout: "", status: null, error: timedOut };
    },
  });
  assert.throws(
    () => running(123),
    (error: unknown) => error instanceof Error && error.cause === timedOut,
  );
  const denied = Object.assign(new Error("permission denied"), {
    code: "EPERM",
  });
  const forbidden = createLivenessProbe({
    ...port,
    probe() {
      throw denied;
    },
  });
  assert.throws(
    () => forbidden(123),
    (error: unknown) => error === denied,
  );
}, 5000);

test("a process disappearing during inspection is gone and malformed output remains unknown", () => {
  expect(
    createLivenessProbe({
      ...port,
      inspect() {
        return { stdout: "", status: 1 };
      },
    })(123),
  ).toBe(false);
  assert.throws(
    () =>
      createLivenessProbe({
        ...port,
        inspect() {
          return { stdout: "", status: 0 };
        },
      })(123),
    /Could not confirm/,
  );
  assert.throws(
    () =>
      createLivenessProbe({
        ...port,
        platform: "linux",
        readStat() {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        },
      })(123),
    /denied/,
  );
  expect(createLivenessProbe({ ...port, platform: "linux" })(123)).toBe(false);
}, 5000);

test("a member still exiting just after a stop is waited for, and one that never exits is reported", async () => {
  // A group counts as stopped once SIGKILL is accepted; a member can answer a probe a moment longer.
  let probes = 0;
  const exitingSoon = (pid: number): boolean => pid === 2 && ++probes <= 3;
  expect(exitingSoon(2)).toBe(true); // a single check right after the stop sees it
  expect(
    await waitUntilGone([1, 2], exitingSoon, () => Promise.resolve()),
  ).toBe(true);
  expect(
    await waitUntilGone(
      [1, 2],
      () => true,
      () => Promise.resolve(),
    ),
  ).toBe(false);
}, 5000);
