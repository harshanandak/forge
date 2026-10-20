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
  // SIGKILL is re-sent so a child forked while the first one landed is caught too.
  expect(sent.filter((signal) => signal === "SIGKILL")).toHaveLength(4);
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

test("SIGKILL re-sends stop as soon as the group is gone", async () => {
  const sent: (NodeJS.Signals | 0)[] = [];
  let kills = 0;
  const stopped = await endProcessGroup(7, timing, (_pid, signal) => {
    sent.push(signal);
    if (signal === "SIGKILL" && ++kills === 2) throw errno("ESRCH");
  });
  expect(stopped).toBe(true);
  expect(sent.filter((signal) => signal === "SIGKILL")).toHaveLength(2);
}, 5_000);

test("a SIGKILL re-send the OS keeps refusing is reported as not stopped", async () => {
  let kills = 0;
  const stopped = await endProcessGroup(7, timing, (_pid, signal) => {
    if (signal === "SIGKILL" && ++kills >= 3) throw errno("EPERM");
  });
  expect(stopped).toBe(false);
}, 5_000);

test("a group left with only unreaped zombies on macOS counts as stopped once the leader is reaped", async () => {
  // macOS skips zombies when signalling a group and answers EPERM when no live member is left,
  // until the leader is reaped and the group disappears (CI run 39481463635).
  let reap = (): void => undefined;
  const reaped = new Promise<void>((resolve) => (reap = resolve));
  let isReaped = false;
  void reaped.then(() => (isReaped = true));
  const sent: (NodeJS.Signals | 0)[] = [];
  const stopped = await endProcessGroup(
    7,
    timing,
    (_pid, signal) => {
      sent.push(signal);
      if (signal === "SIGTERM") {
        setTimeout(reap, 30);
        return;
      }
      throw errno(isReaped ? "ESRCH" : "EPERM");
    },
    reaped,
  );
  expect(stopped).toBe(true);
  expect(sent.at(-1)).toBe("SIGKILL");
}, 5_000);
