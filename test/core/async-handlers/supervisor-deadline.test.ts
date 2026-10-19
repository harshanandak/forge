import { expect, test } from "bun:test";
import { createSupervisorDeadline } from "../../../src/adapters/process/supervisor-deadline.ts";

function clock() {
  let now = 0;
  let callback: (() => void) | undefined;
  let delay: number | undefined;
  let stopped = 0;
  return {
    port: {
      now: () => now,
      schedule(action: () => void, ms: number) {
        callback = action;
        delay = ms;
      },
      terminate() {
        stopped++;
      },
    },
    advance(ms: number) {
      now += ms;
    },
    fire() {
      callback?.();
    },
    get delay() {
      return delay;
    },
    get stopped() {
      return stopped;
    },
  };
}

test("a supervisor that never receives start expires at its declared budget", () => {
  const time = clock();
  const deadline = createSupervisorDeadline("23", time.port);
  expect(time.delay).toBe(23);
  expect(deadline.active()).toBe(true);
  time.advance(23);
  time.fire();
  expect(time.stopped).toBe(1);
  expect(deadline.active()).toBe(false);
  time.fire();
  expect(time.stopped).toBe(1);
}, 5000);

test("a supervised command that never exits cannot reset its startup deadline", () => {
  const time = clock();
  const deadline = createSupervisorDeadline("23", time.port);
  time.advance(10);
  expect(deadline.active()).toBe(true);
  time.advance(13);
  time.fire();
  expect(deadline.active()).toBe(false);
  expect(time.stopped).toBe(1);
}, 5000);

test("a delayed timer cannot allow start after the supervisor deadline", () => {
  const time = clock();
  const deadline = createSupervisorDeadline("23", time.port);
  time.advance(23);
  expect(deadline.active()).toBe(false);
  expect(time.stopped).toBe(1);
}, 5000);

test("supervisor deadlines refuse missing, malformed and unsafe runtime budgets", () => {
  for (const budget of [
    undefined,
    "",
    "0",
    "-1",
    "1.5",
    "1e3",
    "2147483648",
    "23x",
  ]) {
    const time = clock();
    expect(() => createSupervisorDeadline(budget, time.port)).toThrow();
    expect(time.delay).toBeUndefined();
  }
  const time = clock();
  expect(createSupervisorDeadline("2147483647", time.port).active()).toBe(true);
  expect(time.delay).toBe(2147483647);
}, 5000);
