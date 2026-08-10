"use strict";

const { describe, expect, test } = require("bun:test");

const {
  EVENT_BYTE_BUDGET,
  ProcessLifecycleError,
  createProcessLifecycle,
  createProcessState,
  reduceProcessLifecycle,
} = require("../src/process-lifecycle.js");

function clockSequence(values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

function options(overrides = {}) {
  return {
    processId: "process-1",
    clock: clockSequence([0, 10, 20, 30, 40, 50, 60]),
    graceMs: 20,
    maxAttempts: 3,
    maxElapsedMs: 100,
    maxEvents: 12,
    maxHistory: 12,
    ...overrides,
  };
}

function event(id, type, fields = {}) {
  return { id, type, ...fields };
}

function maxLengthId(index) {
  const prefix = String(index).padStart(3, "0");
  return `${prefix}${"i".repeat(128 - prefix.length)}`;
}

function nearBudgetEvent(id, type) {
  const empty = event(id, type, { metadata: { blob: "" } });
  const blobLength = EVENT_BYTE_BUDGET - Buffer.byteLength(JSON.stringify(empty), "utf8") - 32;
  return event(id, type, { metadata: { blob: "x".repeat(blobLength) } });
}

function throwingProxy(value, trap) {
  return new Proxy(value, {
    [trap]() {
      throw new Error(`${trap} trap`);
    },
  });
}

function startRunning(overrides = {}) {
  const lifecycle = createProcessLifecycle(options(overrides));
  lifecycle.dispatch(event("start", "start"));
  return lifecycle;
}

describe("process lifecycle state machine", () => {
  test("covers normal exit, termination acknowledgement, child reaping, and terminal receipt", () => {
    const lifecycle = startRunning();
    expect(lifecycle.dispatch(event("exit", "exit", { code: 0 })).effects)
      .toEqual([{ type: "ACKNOWLEDGE_TERMINATION", code: 0, signal: null }]);
    expect(lifecycle.snapshot()).toMatchObject({ phase: "EXITED", terminationAcknowledged: false, childReaped: false });

    const acknowledged = lifecycle.dispatch(event("ack", "termination-acknowledged"));
    expect(acknowledged.effects).toEqual([{ type: "REAP_CHILD" }]);
    expect(acknowledged.state.phase).toBe("TERMINATION_ACKNOWLEDGED");

    const reaped = lifecycle.dispatch(event("reap", "reap", { childReaped: true }));
    expect(reaped.effects).toEqual([{ type: "REAP_COMPLETE" }]);
    expect(reaped.state).toMatchObject({ phase: "TERMINAL", status: "PASS", terminationAcknowledged: true, childReaped: true });
  });

  test("normal non-zero exit becomes a failed terminal receipt only after reap", () => {
    const lifecycle = startRunning();
    lifecycle.dispatch(event("exit", "exit", { code: 17 }));
    lifecycle.dispatch(event("ack", "termination-acknowledged"));
    const terminal = lifecycle.dispatch(event("reap", "reap", { childReaped: true }));
    expect(terminal.state.status).toBe("FAIL");
    expect(terminal.state.exitCode).toBe(17);
  });

  test("cancel request/acknowledgement requires child reaping", () => {
    const lifecycle = startRunning();
    expect(lifecycle.dispatch(event("cancel", "cancel-requested")).effects)
      .toEqual([{ type: "REQUEST_TERMINATION" }]);
    const acknowledged = lifecycle.dispatch(event("cancel-ack", "cancel-acknowledged"));
    expect(acknowledged.effects).toEqual([{ type: "REAP_CHILD" }]);
    expect(acknowledged.state).toMatchObject({ phase: "TERMINATION_ACKNOWLEDGED", status: "CANCELLED" });
    expect(() => lifecycle.dispatch(event("late", "tick"))).toThrow(ProcessLifecycleError);
    const terminal = lifecycle.dispatch(event("reap", "reap", { childReaped: true }));
    expect(terminal.state).toMatchObject({ phase: "TERMINAL", status: "CANCELLED" });
  });

  test("grace expiry emits force-kill, then forced-kill acknowledgement and reap", () => {
    const lifecycle = startRunning({ clock: clockSequence([0, 10, 31, 40, 50]) });
    lifecycle.dispatch(event("cancel", "cancel-requested"));
    const expired = lifecycle.dispatch(event("grace", "grace-expired"));
    expect(expired.effects).toEqual([{ type: "FORCE_KILL" }]);
    expect(expired.state.phase).toBe("FORCE_KILL_REQUESTED");
    const killed = lifecycle.dispatch(event("kill-ack", "forced-kill-acknowledged", { signal: "SIGKILL" }));
    expect(killed.effects).toEqual([{ type: "REAP_CHILD" }]);
    const terminal = lifecycle.dispatch(event("reap", "reap", { childReaped: true }));
    expect(terminal.state).toMatchObject({ phase: "TERMINAL", status: "CANCELLED", forcedKill: true });
  });

  test("orphan reaping is an abstract effect and still requires acknowledged termination", () => {
    const lifecycle = startRunning();
    const orphan = lifecycle.dispatch(event("orphan", "orphan-detected"));
    expect(orphan.effects).toEqual([{ type: "REAP_ORPHAN" }]);
    expect(orphan.state.phase).toBe("ORPHANED");
    const ack = lifecycle.dispatch(event("orphan-ack", "termination-acknowledged"));
    expect(ack.effects).toEqual([{ type: "REAP_CHILD" }]);
    const done = lifecycle.dispatch(event("orphan-reap", "reap", { childReaped: true }));
    expect(done.state).toMatchObject({ phase: "TERMINAL", status: "INCOMPLETE", childReaped: true });
  });

  test("duplicate-identical events are idempotent and conflicts/post-terminal events reject", () => {
    const lifecycle = createProcessLifecycle(options());
    const start = event("start", "start");
    const first = lifecycle.dispatch(start);
    expect(lifecycle.dispatch({ ...start }).state).toEqual(first.state);
    expect(lifecycle.dispatch({ ...start }).effects).toEqual([]);
    expect(() => lifecycle.dispatch(event("start", "exit", { code: 0 }))).toThrow("identity conflict");
    lifecycle.dispatch(event("exit", "exit", { code: 0 }));
    lifecycle.dispatch(event("ack", "termination-acknowledged"));
    lifecycle.dispatch(event("reap", "reap", { childReaped: true }));
    expect(() => lifecycle.dispatch(event("late", "tick"))).toThrow("post-terminal");
  });

  test.each(["__proto__", "constructor", "toString"])("treats hostile event ids as ordinary identities: %s", (id) => {
    const lifecycle = createProcessLifecycle(options());
    const first = lifecycle.dispatch(event(id, "start"));
    expect(first.state.phase).toBe("RUNNING");
    expect(lifecycle.dispatch(event(id, "start")).effects).toEqual([]);
  });

  test.each([
    ["bad exit code", { code: Infinity }],
    ["bad signal", { signal: { then() {} } }],
    ["non-finite grace", { graceMs: Number.NaN }],
    ["array event", []],
  ])("fails closed on malformed lifecycle input: %s", (_name, malformed) => {
    const lifecycle = createProcessLifecycle(options());
    if (malformed.graceMs !== undefined) {
      expect(() => createProcessLifecycle(options(malformed))).toThrow(ProcessLifecycleError);
      return;
    }
    lifecycle.dispatch(event("start", "start"));
    const input = Array.isArray(malformed) ? malformed : { id: "bad", type: "exit", ...malformed };
    expect(() => lifecycle.dispatch(input)).toThrow(ProcessLifecycleError);
    expect(lifecycle.snapshot().phase).toBe("RUNNING");
  });

  test("rejects non-monotonic clocks, elapsed/attempt/event overflow, and mutable accessors", () => {
    const lifecycle = createProcessLifecycle(options({ clock: clockSequence([20, 10]) }));
    lifecycle.dispatch(event("start", "start"));
    expect(() => lifecycle.dispatch(event("tick", "tick"))).toThrow("non-monotonic");

    expect(() => createProcessLifecycle(options({ maxAttempts: Number.MAX_SAFE_INTEGER + 1 }))).toThrow();
    const capped = createProcessLifecycle(options({ maxEvents: 1, maxHistory: 1 }));
    capped.dispatch(event("start", "start"));
    expect(() => capped.dispatch(event("exit", "exit", { code: 0 }))).toThrow("event cap");

    const getterEvent = { id: "getter", type: "start" };
    Object.defineProperty(getterEvent, "code", { get() { throw new Error("should not invoke"); } });
    const safe = createProcessLifecycle(options());
    expect(() => safe.dispatch(getterEvent)).toThrow(ProcessLifecycleError);
    expect(safe.snapshot().phase).toBe("READY");
  });

  test("pure reducer clones events and emits no process or OS side effects", () => {
    const initial = createProcessState(options(), 0);
    const input = event("s", "start", { metadata: { child: "x" } });
    const result = reduceProcessLifecycle(initial, input, options());
    input.metadata.child = "mutated";
    expect(result.state.history[0].metadata.child).toBe("x");
    expect(result.effects).toEqual([{ type: "START_PROCESS", processId: "process-1" }]);
  });

  test("serializes a deterministic bounded snapshot", () => {
    const lifecycle = startRunning();
    const snapshot = lifecycle.snapshot();
    expect(JSON.parse(lifecycle.serialize())).toEqual(snapshot);
    expect(() => {
      snapshot.history[0].type = "mutated";
    }).toThrow(TypeError);
    expect(lifecycle.snapshot().history[0].type).toBe("start");
  });

  test("does not let a caller mutate dispatch state or the runtime snapshot", () => {
    const lifecycle = createProcessLifecycle(options());
    const started = lifecycle.dispatch(event("start", "start"));
    expect(Object.isFrozen(started.state)).toBe(true);
    expect(() => {
      started.state.phase = "TERMINAL";
    }).toThrow(TypeError);
    expect(lifecycle.snapshot().phase).toBe("RUNNING");
    expect(lifecycle.dispatch(event("exit", "exit", { code: 0 })).state.phase).toBe("EXITED");
  });

  test("rejects a forged acknowledgement phase without a truthful termination acknowledgement", () => {
    const forged = createProcessState(options(), 0);
    forged.phase = "TERMINATION_ACKNOWLEDGED";
    forged.exitCode = 0;
    forged.terminationAcknowledged = false;
    expect(() => reduceProcessLifecycle(forged, event("reap", "reap", { childReaped: true }), options()))
      .toThrow(ProcessLifecycleError);
  });

  test.each(["ownKeys", "getOwnPropertyDescriptor"])("fails closed for a Proxy %s trap on state, event, or options", (trap) => {
    const initial = createProcessState(options(), 0);
    expect(() => reduceProcessLifecycle(throwingProxy(initial, trap), event("s", "start"), options()))
      .toThrow(ProcessLifecycleError);
    expect(() => reduceProcessLifecycle(initial, throwingProxy(event("s", "start"), trap), options()))
      .toThrow(ProcessLifecycleError);
    expect(() => createProcessLifecycle(throwingProxy(options(), trap))).toThrow(ProcessLifecycleError);
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
    expect(() => reduceProcessLifecycle(
      createProcessState(options(), 0),
      event("s", "start"),
      rawOptions,
    )).toThrow(ProcessLifecycleError);
    expect(getterCalled).toBe(false);
  });

  test("clones a bounded large state before the next reducer dispatch", () => {
    const lifecycle = createProcessLifecycle(options());
    const started = lifecycle.dispatch(event("start", "start", { metadata: { blob: "x".repeat(12_000) } }));
    expect(started.state.history[0].metadata.blob.length).toBe(12_000);
    expect(lifecycle.dispatch(event("tick", "tick")).state.phase).toBe("RUNNING");
  });

  test("preserves absent exitCode, rejects an outcome-less exit, and never passes a signal termination", () => {
    const outcomeLess = startRunning();
    expect(() => outcomeLess.dispatch(event("outcome-less", "exit"))).toThrow(ProcessLifecycleError);
    expect(outcomeLess.snapshot().phase).toBe("RUNNING");

    const signalled = startRunning();
    const exited = signalled.dispatch(event("sigsegv", "exit", { signal: "SIGSEGV" }));
    expect(exited.state).toMatchObject({ exitCode: null, signal: "SIGSEGV" });
    signalled.dispatch(event("ack", "termination-acknowledged"));
    const terminal = signalled.dispatch(event("reap", "reap", { childReaped: true }));
    expect(terminal.state.status).toBe("FAIL");
    expect(terminal.state.status).not.toBe("PASS");
  });

  test.each(["tick", "deadline"])("elapsed cap remains INCOMPLETE through %s, acknowledgement, and reap", (eventType) => {
    const lifecycle = startRunning({ clock: clockSequence([0, 101, 101, 101]), maxElapsedMs: 100 });
    const capped = lifecycle.dispatch(event(`cap-${eventType}`, eventType));
    expect(capped.state).toMatchObject({
      phase: "CANCEL_REQUESTED",
      status: "INCOMPLETE",
      terminalReason: "ELAPSED_CAP",
    });
    const acknowledged = lifecycle.dispatch(event(`ack-${eventType}`, "cancel-acknowledged"));
    expect(acknowledged.state.status).toBe("INCOMPLETE");
    const terminal = lifecycle.dispatch(event(`reap-${eventType}`, "reap", { childReaped: true }));
    expect(terminal.state).toMatchObject({ phase: "TERMINAL", status: "INCOMPLETE", terminalReason: "ELAPSED_CAP" });
  });

  test("accepts the configured 256-event ceiling with fixed-size seen-event digests", () => {
    const lifecycle = createProcessLifecycle(options({
      clock: () => 0,
      maxEvents: 256,
      maxHistory: 256,
    }));
    lifecycle.dispatch(nearBudgetEvent(maxLengthId(0), "start"));
    for (let index = 1; index < 256; index += 1) {
      lifecycle.dispatch(nearBudgetEvent(maxLengthId(index), "tick"));
    }
    const snapshot = lifecycle.snapshot();
    expect(snapshot.eventCount).toBe(256);
    expect(snapshot.history).toHaveLength(256);
    expect(Object.keys(snapshot.seenEvents)).toHaveLength(256);
    expect(Object.values(snapshot.seenEvents).every((digest) => /^[0-9a-f]{64}$/.test(digest))).toBe(true);
    const serialized = lifecycle.serialize();
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(4_194_304);
    expect(JSON.parse(serialized)).toEqual(snapshot);
    expect(() => lifecycle.dispatch(nearBudgetEvent(maxLengthId(256), "tick"))).toThrow("event cap");
  });
});
