import { expect, test } from "bun:test";
import { endProcessGroup } from "../../../src/adapters/process/process-tree.ts";

const timing = { cleanupTimeoutMs: 400, pollIntervalMs: 10 };

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

test("a group left with only zombies after SIGKILL counts as stopped, without waiting", async () => {
  const sent: (NodeJS.Signals | 0)[] = [];
  // Zombies keep answering a signal-zero probe of their group until something reaps them.
  const started = performance.now();
  const stopped = await endProcessGroup(4242, timing, (pid, signal) => {
    expect(pid).toBe(-4242);
    sent.push(signal);
  });
  expect(stopped).toBe(true);
  expect(sent[0]).toBe("SIGTERM");
  expect(sent.at(-1)).toBe("SIGKILL");
  // Only the SIGTERM grace (half the budget) is spent; nothing polls after SIGKILL.
  expect(performance.now() - started).toBeLessThan(
    timing.cleanupTimeoutMs * 0.9,
  );
}, 5_000);

test("a group that exits after SIGTERM is never sent SIGKILL", async () => {
  const sent: (NodeJS.Signals | 0)[] = [];
  const stopped = await endProcessGroup(7, timing, (_pid, signal) => {
    sent.push(signal);
    if (signal === 0) throw errno("ESRCH");
  });
  expect(stopped).toBe(true);
  expect(sent).toEqual(["SIGTERM", 0]);
}, 5_000);

test("a SIGKILL the OS refuses is reported as not stopped", async () => {
  const stopped = await endProcessGroup(7, timing, (_pid, signal) => {
    if (signal === "SIGKILL") throw errno("EPERM");
  });
  expect(stopped).toBe(false);
}, 5_000);
