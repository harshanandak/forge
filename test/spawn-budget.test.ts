import { expect, test } from "bun:test";
import type { SpawnSyncReturns } from "node:child_process";
import { removeQuietly, spawnBudget } from "./spawn-budget.ts";

type Reply = Partial<SpawnSyncReturns<string>> & { takes?: number };

/** A budget on a fake clock and a fake spawn, so no real process starts. */
function scripted(testTimeoutMs: number, replies: Reply[]) {
  let clock = 1_000;
  const timeouts: unknown[] = [];
  const budget = spawnBudget(testTimeoutMs, {
    now: () => clock,
    spawn: (_command, _args, options) => {
      timeouts.push(options.timeout);
      const { takes = 0, ...reply } = replies.shift() ?? {};
      clock += takes;
      return {
        pid: 1,
        output: [],
        stdout: "",
        stderr: "",
        status: 0,
        signal: null,
        ...reply,
      };
    },
  });
  return { budget, timeouts, advance: (ms: number) => (clock += ms) };
}

test("each call gets what is left of the test timeout minus the reserve", () => {
  const { budget, timeouts } = scripted(30_000, [
    { takes: 10_000 },
    { takes: 1 },
  ]);
  expect(budget.remainingMs()).toBe(25_000);
  budget.run("first", "git", ["init"]);
  budget.run("second", "git", ["status"]);
  expect(timeouts).toEqual([25_000, 15_000]);
  expect(budget.remainingMs()).toBe(14_999);
}, 30_000);

test("a spent budget refuses to spawn and names the earlier calls", () => {
  const { budget, timeouts } = scripted(10_000, [
    { takes: 2_000 },
    { takes: 3_000 },
  ]);
  budget.run("git init", "git", ["init"]);
  budget.run("forge check run", "node", ["forge.js"]);
  expect(budget.remainingMs()).toBe(0);
  expect(() => budget.run("forge config show", "node", [])).toThrow(
    "forge config show was not started: the 5000 ms scenario budget is used up by git init 2000 ms; forge check run 3000 ms",
  );
  expect(timeouts).toHaveLength(2);
}, 30_000);

test("a timeout of zero or a fraction is never passed to spawn", () => {
  const { budget, timeouts, advance } = scripted(10_000, [{}]);
  advance(4_999.5);
  expect(budget.remainingMs()).toBe(0.5);
  expect(() => budget.run("late", "git", [])).toThrow("was not started");
  advance(-4_000);
  budget.run("early", "git", []);
  expect(timeouts).toEqual([4_000]);
  for (const timeout of timeouts)
    expect(Number.isInteger(timeout) && (timeout as number) > 0).toBe(true);
}, 30_000);

test("a killed call is named with its status, signal, error and earlier calls", () => {
  const { budget } = scripted(30_000, [
    { takes: 400 },
    {
      takes: 25_000,
      status: null,
      signal: "SIGTERM",
      error: new Error("spawnSync node ETIMEDOUT"),
      stderr: "partial output",
    },
  ]);
  budget.run("forge catalog list", "node", ["forge.js"]);
  let message = "";
  try {
    budget.run("forge check run", "node", ["forge.js"], {}, 0);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain("forge check run was killed after 25000 ms");
  expect(message).toContain("of a 24600 ms budget");
  expect(message).toContain("status null");
  expect(message).toContain("signal SIGTERM");
  expect(message).toContain("error spawnSync node ETIMEDOUT");
  expect(message).toContain("earlier calls: forge catalog list 400 ms");
  expect(message).toContain("partial output");
}, 30_000);

test("a killed call is reported even when the caller expects no status", () => {
  const { budget } = scripted(30_000, [{ status: null }]);
  expect(() => budget.run("git init", "git", ["init"])).toThrow(
    "git init was killed after 0 ms",
  );
}, 30_000);

test("an unexpected exit status is reported with the output", () => {
  const { budget } = scripted(30_000, [
    { status: 1, stderr: "fatal: bad", stdout: "out" },
  ]);
  expect(() => budget.run("git add", "git", ["add"], {}, 0)).toThrow(
    "git add exited 1, expected 0, after 0 ms of a 25000 ms budget; earlier calls: none\nfatal: badout",
  );
}, 30_000);

test("a status the caller did not pin is returned for its own assertions", () => {
  const { budget } = scripted(30_000, [{ status: 2, stdout: "red" }]);
  const result = budget.run("forge check run", "node", []);
  expect(result.status).toBe(2);
  expect(result.stdout).toBe("red");
}, 30_000);

test("cleanup that fails does not replace the test's own error", () => {
  expect(() => removeQuietly("not\0a path")).not.toThrow();
}, 30_000);
