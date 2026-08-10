"use strict";

const { describe, expect, test } = require("bun:test");

const {
  BoundedLoopError,
  createBoundedLoop,
  createBoundedLoopState,
  reduceBoundedLoop,
} = require("../src/bounded-loop.js");

function clockSequence(values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

function options(overrides = {}) {
  return {
    loopId: "loop-1",
    clock: clockSequence([0, 10, 20, 30, 40, 50]),
    maxAttempts: 3,
    maxElapsedMs: 100,
    maxEvents: 8,
    maxHistory: 8,
    ...overrides,
  };
}

function event(id, type, fields = {}) {
  return { id, type, ...fields };
}

function throwingProxy(value, trap) {
  return new Proxy(value, {
    [trap]() {
      throw new Error(`${trap} trap`);
    },
  });
}

describe("bounded loop state machine", () => {
  test("RED contract exposes a ready state and deterministic start/complete transitions", () => {
    const loop = createBoundedLoop(options());
    expect(loop.snapshot()).toMatchObject({
      loopId: "loop-1",
      phase: "READY",
      status: "PENDING",
      attempts: 0,
      elapsedMs: 0,
      eventCount: 0,
      history: [],
    });

    const started = loop.dispatch(event("start-1", "start"));
    expect(started.effects).toEqual([{ type: "START" }]);
    expect(started.state).toMatchObject({ phase: "RUNNING", attempts: 1, eventCount: 1 });

    const completed = loop.dispatch(event("complete-1", "complete", { status: "PASS" }));
    expect(completed.effects).toEqual([{ type: "COMPLETE", status: "PASS" }]);
    expect(completed.state).toMatchObject({ phase: "TERMINAL", status: "PASS", terminal: true });
  });

  test("supports failure and cancellation request/acknowledgement", () => {
    const failure = createBoundedLoop(options());
    failure.dispatch(event("start", "start"));
    expect(failure.dispatch(event("fail", "fail", { reason: "provider" })).state)
      .toMatchObject({ phase: "TERMINAL", status: "FAIL", terminalReason: "provider" });

    const cancelled = createBoundedLoop(options());
    cancelled.dispatch(event("start", "start"));
    const requested = cancelled.dispatch(event("cancel", "cancel-requested"));
    expect(requested.effects).toEqual([{ type: "CANCEL" }]);
    expect(requested.state.phase).toBe("CANCEL_REQUESTED");
    const acknowledged = cancelled.dispatch(event("cancel-ack", "cancel-acknowledged"));
    expect(acknowledged.effects).toEqual([{ type: "CANCEL_ACKNOWLEDGED" }]);
    expect(acknowledged.state).toMatchObject({ phase: "TERMINAL", status: "CANCELLED" });
  });

  test("uses the injected clock, rejects non-monotonic clocks, and caps elapsed time", () => {
    const regressing = createBoundedLoop(options({ clock: clockSequence([10, 5]) }));
    regressing.dispatch(event("start", "start"));
    expect(() => regressing.dispatch(event("tick", "tick"))).toThrow("non-monotonic");
    expect(regressing.snapshot().phase).toBe("RUNNING");

    const expired = createBoundedLoop(options({ clock: clockSequence([0, 101]), maxElapsedMs: 100 }));
    expired.dispatch(event("start", "start"));
    const result = expired.dispatch(event("tick", "tick"));
    expect(result.effects).toEqual([{ type: "TIMEOUT", elapsedMs: 101 }]);
    expect(result.state).toMatchObject({ phase: "TERMINAL", status: "INCOMPLETE", terminalReason: "ELAPSED_CAP" });
  });

  test("bounds attempts, events, and history without mutating caller input", () => {
    const loop = createBoundedLoop(options({ maxAttempts: 2, maxEvents: 3, maxHistory: 2 }));
    const start = event("start", "start");
    loop.dispatch(start);
    start.type = "fail";
    expect(loop.snapshot().history[0]).toMatchObject({ id: "start", type: "start" });
    loop.dispatch(event("attempt", "attempt"));
    const capped = loop.dispatch(event("attempt-2", "attempt"));
    expect(capped.state).toMatchObject({ phase: "TERMINAL", status: "INCOMPLETE", terminalReason: "ATTEMPT_CAP" });
    expect(capped.effects).toEqual([{ type: "ATTEMPT_CAP", attempts: 3 }]);
  });

  test("deduplicates identical event identities and rejects conflicts/post-terminal input", () => {
    const loop = createBoundedLoop(options());
    const start = event("start", "start");
    const first = loop.dispatch(start);
    const duplicate = loop.dispatch({ ...start });
    expect(duplicate.state).toEqual(first.state);
    expect(duplicate.effects).toEqual([]);
    expect(loop.snapshot().eventCount).toBe(1);

    expect(() => loop.dispatch(event("start", "tick"))).toThrow("identity conflict");
    loop.dispatch(event("done", "complete", { status: "PASS" }));
    expect(() => loop.dispatch(event("late", "tick"))).toThrow("post-terminal");
  });

  test.each(["__proto__", "constructor", "toString"])("treats hostile event ids as ordinary identities: %s", (id) => {
    const loop = createBoundedLoop(options());
    const first = loop.dispatch(event(id, "start"));
    expect(first.state.phase).toBe("RUNNING");
    expect(loop.dispatch(event(id, "start")).effects).toEqual([]);
  });

  test.each([
    ["missing id", { type: "start" }],
    ["unknown type", { id: "x", type: "wat" }],
    ["non-finite event field", { id: "x", type: "attempt", amount: Infinity }],
    ["thenable event", { id: "x", type: "attempt", value: { then() {} } }],
    ["array event", []],
  ])("fails closed for malformed input: %s", (_name, malformed) => {
    const loop = createBoundedLoop(options());
    expect(() => loop.dispatch(malformed)).toThrow(BoundedLoopError);
    expect(loop.snapshot().eventCount).toBe(0);
  });

  test("rejects unsafe limits and pure reducer does not retain mutable references", () => {
    expect(() => createBoundedLoop(options({ maxAttempts: 0 }))).toThrow();
    expect(() => createBoundedLoop(options({ maxEvents: Number.MAX_SAFE_INTEGER + 1 }))).toThrow();

    const initial = createBoundedLoopState(options(), 0);
    const input = event("s", "start", { metadata: { nested: true } });
    const result = reduceBoundedLoop(initial, input, { maxAttempts: 3, maxElapsedMs: 100, maxEvents: 8, maxHistory: 8 });
    input.metadata.nested = false;
    expect(result.state.history[0].metadata.nested).toBe(true);
    expect(() => reduceBoundedLoop(result.state, event("late", "tick"), {
      maxAttempts: 3, maxElapsedMs: 100, maxEvents: 8, maxHistory: 8,
    })).not.toThrow();
  });

  test("provides deterministic serialized state without exposing internal references", () => {
    const loop = createBoundedLoop(options());
    loop.dispatch(event("start", "start"));
    const snapshot = loop.snapshot();
    expect(JSON.parse(loop.serialize())).toEqual(snapshot);
    expect(() => {
      snapshot.history[0].type = "mutated";
    }).toThrow(TypeError);
    expect(loop.snapshot().history[0].type).toBe("start");
  });

  test("does not let a caller mutate dispatch state or the runtime snapshot", () => {
    const loop = createBoundedLoop(options());
    const started = loop.dispatch(event("start", "start"));
    expect(Object.isFrozen(started.state)).toBe(true);
    expect(() => {
      started.state.phase = "TERMINAL";
    }).toThrow(TypeError);
    expect(loop.snapshot().phase).toBe("RUNNING");
    expect(loop.dispatch(event("done", "complete")).state.phase).toBe("TERMINAL");
  });

  test.each(["ownKeys", "getOwnPropertyDescriptor"])("fails closed for a Proxy %s trap on state, event, or options", (trap) => {
    const initial = createBoundedLoopState(options(), 0);
    expect(() => reduceBoundedLoop(throwingProxy(initial, trap), event("s", "start"), options()))
      .toThrow(BoundedLoopError);
    expect(() => reduceBoundedLoop(initial, throwingProxy(event("s", "start"), trap), options()))
      .toThrow(BoundedLoopError);
    expect(() => createBoundedLoop(throwingProxy(options(), trap))).toThrow(BoundedLoopError);
  });

  test("rejects a throwing rawOptions.now accessor as a stable domain error", () => {
    const rawOptions = options();
    let getterCalled = false;
    Object.defineProperty(rawOptions, "now", {
      configurable: true,
      get() {
        getterCalled = true;
        throw new Error("now getter");
      },
    });
    expect(() => reduceBoundedLoop(
      createBoundedLoopState(options(), 0),
      event("s", "start"),
      rawOptions,
    )).toThrow(BoundedLoopError);
    expect(getterCalled).toBe(false);
  });

  test("clones a bounded large state before the next reducer dispatch", () => {
    const loop = createBoundedLoop(options());
    const started = loop.dispatch(event("start", "start", { metadata: { blob: "x".repeat(12_000) } }));
    expect(started.state.history[0].metadata.blob.length).toBe(12_000);
    expect(loop.dispatch(event("tick", "tick")).state.phase).toBe("RUNNING");
  });

  test("validates reducer limits through descriptors without invoking a hostile Proxy get trap", () => {
    let getCount = 0;
    const hostileOptions = new Proxy(Object.create(null), {
      get() {
        getCount += 1;
        throw new Error("options get trap");
      },
    });
    expect(() => reduceBoundedLoop(
      createBoundedLoopState(options(), 0),
      event("s", "start"),
      hostileOptions,
    )).toThrow(BoundedLoopError);
    expect(getCount).toBe(0);
  });
});
