"use strict";

const { beforeAll, describe, expect, mock, test } = require("bun:test");
const contracts = require("../../memory-contracts");

mock.module("@forge/memory-contracts", () => contracts);

const { computeContentHash, validateContractStructure } = contracts;
let MonitorRuntimeError;
let createMonitorReceipt;
let createMonitorState;
let reduceMonitor;
let reduceMonitorBatch;

beforeAll(() => {
  ({
    MonitorRuntimeError,
    createMonitorReceipt,
    createMonitorState,
    reduceMonitor,
    reduceMonitorBatch,
  } = require("../src/monitor-runtime.js"));
});

function spec(overrides = {}) {
  return {
    monitorId: "monitor-1",
    ownerRunId: "run-1",
    packetId: "packet-1",
    subject: { id: "subject-1", revision: "head-1" },
    sourceAdapters: ["in-memory"],
    deadline: "2026-08-09T12:10:00.000Z",
    lifetime: "run",
    deliveryTargets: ["agent-context"],
    securityPolicy: { maxPayloadBytes: 16_384 },
    maxPending: 2,
    maxRetries: 2,
    retryBaseMs: 100,
    reducer: (_previous, observation) => observation.status,
    terminalPredicate: (value) => value === "PASS" || value === "FAIL",
    ...overrides,
  };
}

function observation(sequence, status, overrides = {}) {
  const value = {
    schema_id: "forge.memory.monitor-event.v1",
    schema_version: 1,
    object_id: `00000000-0000-4000-8000-${String(sequence + 10).padStart(12, "0")}`,
    created_at: "2026-08-09T12:01:00.000Z",
    producer: { product_id: "forge-flow", product_version: "0.1.0-beta.6", instance_id: "monitor-1" },
    capabilities_used: [],
    provenance: { source_kind: "monitor", actor_class: "system", actor_id: "monitor-1" },
    payload: {
      monitor_id: "monitor-1",
      event_id: `event-${sequence}`,
      sequence,
      subject_revision: "head-1",
      type: "check.changed",
      actionability: "action_required",
      observed_at: "2026-08-09T12:01:00.000Z",
      bounded_payload: { status },
      ...overrides,
    },
    extensions: {},
  };
  value.content_hash = computeContentHash(value);
  return value;
}

function reduceSequentially(monitorSpec, initialState, events) {
  let state = initialState;
  const effects = [];
  let modelTurns = 0;
  for (const event of events) {
    const transition = reduceMonitor(monitorSpec, state, event);
    state = transition.state;
    effects.push(...transition.effects);
    modelTurns += transition.modelTurns;
  }
  return { state, effects, modelTurns };
}

function capturedError(callback) {
  try {
    callback();
  } catch (error) {
    return error;
  }
  throw new Error("expected callback to throw");
}

describe("MonitorSpec deterministic reducer", () => {
  test("batch replay matches sequential advisory reductions without mutating inputs", () => {
    const monitorSpec = spec({
      terminalPredicate: () => false,
      reducer: (previous = [], payload) => {
        previous.push(payload.status);
        return previous;
      },
    });
    const initialState = createMonitorState(monitorSpec);
    const events = [
      { kind: "observation", event: observation(0, "PENDING", { actionability: "advisory" }) },
      { kind: "observation", event: observation(1, "RUNNING", { actionability: "advisory" }) },
      { kind: "observation", event: observation(2, "GREEN", { actionability: "advisory" }) },
    ];
    const stateSnapshot = structuredClone(initialState);
    const eventSnapshot = structuredClone(events);

    expect(reduceMonitorBatch(monitorSpec, initialState, events))
      .toEqual(reduceSequentially(monitorSpec, initialState, events));
    expect(initialState).toEqual(stateSnapshot);
    expect(events).toEqual(eventSnapshot);
  });

  test("batch replay matches sequential pending, backpressure, retry, and acknowledgement reductions", () => {
    const monitorSpec = spec({ maxPending: 1, terminalPredicate: () => false });
    const initialState = createMonitorState(monitorSpec);
    const events = [
      { kind: "observation", event: observation(0, "PENDING") },
      { kind: "observation", event: observation(1, "RUNNING") },
      { kind: "delivery-failed", sequence: 0, observedAt: "2026-08-09T12:01:01.000Z" },
      { kind: "acknowledge", sequence: 0 },
      { kind: "acknowledge", sequence: 1 },
    ];

    expect(reduceMonitorBatch(monitorSpec, initialState, events))
      .toEqual(reduceSequentially(monitorSpec, initialState, events));
  });

  test("batch replay matches sequential terminal cleanup reductions", () => {
    const monitorSpec = spec();
    const initialState = createMonitorState(monitorSpec);
    const events = [
      { kind: "observation", event: observation(0, "PASS", { actionability: "advisory" }) },
      {
        kind: "cleanup-complete",
        processCleanup: { status: "PASS" },
        leaseCleanup: { status: "PASS" },
      },
    ];

    expect(reduceMonitorBatch(monitorSpec, initialState, events))
      .toEqual(reduceSequentially(monitorSpec, initialState, events));
  });

  test("batch replay rebuilds independently from each strict 128-event suffix", () => {
    const monitorSpec = spec({ maxHistory: 128, terminalPredicate: () => false });
    const observations = Array.from({ length: 129 }, (_, sequence) => ({
      kind: "observation",
      event: observation(sequence, `STATE-${sequence}`, { actionability: "advisory" }),
    }));
    const firstTail = observations.slice(0, 128);
    const shiftedTail = observations.slice(1);

    const first = reduceMonitorBatch(monitorSpec, createMonitorState(monitorSpec), firstTail);
    const shifted = reduceMonitorBatch(monitorSpec, createMonitorState(monitorSpec), shiftedTail);

    expect(first).toEqual(reduceSequentially(monitorSpec, createMonitorState(monitorSpec), firstTail));
    expect(shifted).toEqual(reduceSequentially(monitorSpec, createMonitorState(monitorSpec), shiftedTail));
    expect(Object.keys(first.state.seenEvents)).toHaveLength(128);
    expect(Object.hasOwn(first.state.seenEvents, "event-0")).toBe(true);
    expect(Object.keys(shifted.state.seenEvents)).toHaveLength(128);
    expect(Object.hasOwn(shifted.state.seenEvents, "event-0")).toBe(false);
    expect(Object.hasOwn(shifted.state.seenEvents, "event-128")).toBe(true);
  });

  test.each([
    ["tampered observation", spec({ terminalPredicate: () => false }), () => {
      const event = observation(0, "PENDING");
      event.payload.bounded_payload.status = "TAMPERED";
      return { kind: "observation", event };
    }],
    ["invalid spec", spec({ maxPending: 0 }), () => ({
      kind: "observation", event: observation(0, "PENDING"),
    })],
  ])("batch replay preserves sequential failure parity for %s", (_label, monitorSpec, eventFactory) => {
    const validSpec = spec({ terminalPredicate: () => false });
    const initialState = createMonitorState(validSpec);
    const event = eventFactory();
    const sequentialError = capturedError(() => reduceMonitor(monitorSpec, initialState, event));
    const batchError = capturedError(() => reduceMonitorBatch(monitorSpec, initialState, [event]));

    expect(batchError.constructor).toBe(sequentialError.constructor);
    expect(batchError).toMatchObject({ message: sequentialError.message });
    if (sequentialError.code !== undefined) expect(batchError.code).toBe(sequentialError.code);
  });

  test("emits a delivery only for an actionable state transition", () => {
    const monitorSpec = spec({ terminalPredicate: () => false });
    const result = reduceMonitor(monitorSpec, createMonitorState(monitorSpec), {
      kind: "observation",
      event: observation(0, "PENDING"),
    });

    expect(result.state).toMatchObject({ lastSequence: 0, acknowledgementCursor: -1, value: "PENDING" });
    expect(result.effects).toEqual([expect.objectContaining({ type: "DELIVER", eventId: "event-0" })]);
    expect(result.modelTurns).toBe(1);
  });

  test.each([
    ["filter promise", { filter: () => Promise.resolve(true), terminalPredicate: () => false }],
    ["filter non-boolean", { filter: () => "yes", terminalPredicate: () => false }],
    ["terminal promise", { terminalPredicate: () => Promise.resolve(false) }],
    ["terminal non-boolean", { terminalPredicate: () => "PASS" }],
  ])("requires synchronous boolean callback decisions: %s", (_label, overrides) => {
    const monitorSpec = spec(overrides);

    expect(() => reduceMonitor(monitorSpec, createMonitorState(monitorSpec), {
      kind: "observation",
      event: observation(0, "PENDING"),
    })).toThrow("synchronous boolean");
  });

  test.each(["filter", "terminalPredicate"])("consumes a rejected asynchronous %s decision", async (callbackName) => {
    let rejectionConsumed = false;
    const rejection = {
      then(_resolve, reject) {
        rejectionConsumed = true;
        reject(new Error(`${callbackName} unavailable`));
      },
    };
    const monitorSpec = spec({
      terminalPredicate: callbackName === "terminalPredicate" ? () => rejection : () => false,
      ...(callbackName === "filter" ? { filter: () => rejection } : {}),
    });

    expect(() => reduceMonitor(monitorSpec, createMonitorState(monitorSpec), {
      kind: "observation",
      event: observation(0, "PENDING"),
    })).toThrow("synchronous boolean");
    await Promise.resolve();
    await Promise.resolve();
    expect(rejectionConsumed).toBe(true);
  });

  test("classifies a synchronous reducer failure", () => {
    const monitorSpec = spec({ reducer: () => { throw new Error("reducer unavailable"); } });

    try {
      reduceMonitor(monitorSpec, createMonitorState(monitorSpec), {
        kind: "observation",
        event: observation(0, "PENDING"),
      });
      throw new Error("expected reducer failure");
    } catch (error) {
      expect(error).toBeInstanceOf(MonitorRuntimeError);
      expect(error.code).toBe("CALLBACK_FAILURE");
    }
  });

  test("consumes and classifies a rejected asynchronous reducer", async () => {
    let rejectionConsumed = false;
    const rejection = {
      then(_resolve, reject) {
        rejectionConsumed = true;
        reject(new Error("reducer unavailable"));
      },
    };
    const monitorSpec = spec({ reducer: () => rejection });

    expect(() => reduceMonitor(monitorSpec, createMonitorState(monitorSpec), {
      kind: "observation",
      event: observation(0, "PENDING"),
    })).toThrow("reducer must be synchronous");
    await Promise.resolve();
    await Promise.resolve();
    expect(rejectionConsumed).toBe(true);
  });

  test.each([
    ["source adapter item", { sourceAdapters: [42] }],
    ["delivery target item", { deliveryTargets: [""] }],
    ["source adapter count", { sourceAdapters: Array.from({ length: 129 }, (_, index) => `source-${index}`) }],
    ["max pending", { maxPending: 129 }],
    ["max retries", { maxRetries: 33 }],
    ["payload bytes", { securityPolicy: { maxPayloadBytes: 16_385 } }],
    ["retry overflow", { maxRetries: 32, retryBaseMs: Number.MAX_SAFE_INTEGER }],
  ])("rejects unsafe or unbounded MonitorSpec values: %s", (_label, overrides) => {
    expect(() => createMonitorState(spec(overrides))).toThrow();
  });

  test("suppresses duplicate-identical and unchanged observations without a model turn", () => {
    const monitorSpec = spec({ terminalPredicate: () => false });
    const first = reduceMonitor(monitorSpec, createMonitorState(monitorSpec), {
      kind: "observation", event: observation(0, "PENDING"),
    });
    const duplicate = reduceMonitor(monitorSpec, first.state, {
      kind: "observation", event: observation(0, "PENDING"),
    });
    const unchanged = reduceMonitor(monitorSpec, duplicate.state, {
      kind: "observation", event: observation(1, "PENDING"),
    });

    expect(duplicate.effects).toEqual([]);
    expect(duplicate.modelTurns).toBe(0);
    expect(unchanged.effects).toEqual([]);
    expect(unchanged.modelTurns).toBe(0);
    expect(unchanged.state.lastSequence).toBe(1);
  });

  test("fails closed on conflicting duplicate identity and invalid bounded evidence", () => {
    const monitorSpec = spec({ terminalPredicate: () => false });
    const firstEvent = observation(0, "PENDING");
    const first = reduceMonitor(monitorSpec, createMonitorState(monitorSpec), { kind: "observation", event: firstEvent });
    const conflicting = structuredClone(firstEvent);
    conflicting.payload.bounded_payload.status = "RUNNING";
    conflicting.content_hash = computeContentHash(conflicting);

    expect(() => reduceMonitor(monitorSpec, first.state, { kind: "observation", event: conflicting })).toThrow("identity conflict");
    const secret = observation(1, "PENDING", { bounded_payload: { token: `ghp_${"x".repeat(24)}` } });
    secret.content_hash = computeContentHash(secret);
    expect(() => reduceMonitor(monitorSpec, first.state, { kind: "observation", event: secret })).toThrow("MonitorEvent validation failed");
  });

  test("advances acknowledgement cursor monotonically and releases pending delivery", () => {
    const monitorSpec = spec({ terminalPredicate: () => false });
    const observed = reduceMonitor(monitorSpec, createMonitorState(monitorSpec), {
      kind: "observation", event: observation(0, "PENDING"),
    });
    const acknowledged = reduceMonitor(monitorSpec, observed.state, { kind: "acknowledge", sequence: 0 });

    expect(acknowledged.state.acknowledgementCursor).toBe(0);
    expect(acknowledged.state.pending).toEqual([]);
    expect(() => reduceMonitor(monitorSpec, acknowledged.state, { kind: "acknowledge", sequence: -1 })).toThrow("acknowledgement cursor");
  });

  test("makes bounded retry and backpressure decisions", () => {
    const monitorSpec = spec({ maxPending: 1, terminalPredicate: () => false });
    const first = reduceMonitor(monitorSpec, createMonitorState(monitorSpec), {
      kind: "observation", event: observation(0, "PENDING"),
    });
    const pressured = reduceMonitor(monitorSpec, first.state, {
      kind: "observation", event: observation(1, "RUNNING"),
    });
    const retry = reduceMonitor(monitorSpec, pressured.state, {
      kind: "delivery-failed", sequence: 0, observedAt: "2026-08-09T12:01:01.000Z",
    });

    expect(pressured.effects).toEqual([expect.objectContaining({ type: "BACKPRESSURE", decision: "DEFER" })]);
    expect(pressured.modelTurns).toBe(0);
    expect(retry.effects).toEqual([expect.objectContaining({ type: "RETRY_DELIVERY", delayMs: 100 })]);
  });

  test("queues a backpressured transition, fences its acknowledgement, and drains it after capacity opens", () => {
    const monitorSpec = spec({ maxPending: 1, terminalPredicate: () => false });
    const first = reduceMonitor(monitorSpec, createMonitorState(monitorSpec), {
      kind: "observation", event: observation(0, "PENDING"),
    });
    const pressured = reduceMonitor(monitorSpec, first.state, {
      kind: "observation", event: observation(1, "RUNNING"),
    });

    expect(pressured.state.deferred).toEqual([{ sequence: 1, eventId: "event-1" }]);
    expect(() => reduceMonitor(monitorSpec, pressured.state, { kind: "acknowledge", sequence: 1 })).toThrow("acknowledgement cursor");

    const drained = reduceMonitor(monitorSpec, pressured.state, { kind: "acknowledge", sequence: 0 });
    expect(drained.state.pending).toEqual([{ sequence: 1, eventId: "event-1" }]);
    expect(drained.state.deferred).toEqual([]);
    expect(drained.effects).toEqual([expect.objectContaining({ type: "DELIVER", eventId: "event-1" })]);
    expect(drained.modelTurns).toBe(1);
  });

  test("waits for cancellation acknowledgement, performs cleanup, and emits a valid terminal receipt", () => {
    const monitorSpec = spec({ terminalPredicate: () => false });
    const requested = reduceMonitor(monitorSpec, createMonitorState(monitorSpec), { kind: "cancel-requested" });
    const acknowledged = reduceMonitor(monitorSpec, requested.state, {
      kind: "cancel-acknowledged", observedAt: "2026-08-09T12:02:00.000Z",
    });
    const cleaned = reduceMonitor(monitorSpec, acknowledged.state, {
      kind: "cleanup-complete",
      processCleanup: { status: "PASS" },
      leaseCleanup: { status: "PASS" },
    });
    const receipt = createMonitorReceipt(monitorSpec, cleaned.state, {
      objectId: "00000000-0000-4000-8000-000000000011",
      createdAt: "2026-08-09T12:02:01.000Z",
      producerInstanceId: "monitor-1",
    });

    expect(requested.state.lifecycle).toBe("ACTIVE");
    expect(acknowledged.state).toMatchObject({ lifecycle: "TERMINATING", cancellationAcknowledged: true });
    expect(acknowledged.effects.map((effect) => effect.type)).toEqual(["CLEANUP_PROCESS", "CLEANUP_LEASE"]);
    expect(cleaned.state.lifecycle).toBe("TERMINAL");
    expect(receipt.payload).toMatchObject({ terminal_state: "CANCELLED", cancellation_acknowledged: true });
    expect(validateContractStructure(receipt).ok).toBe(true);
    expect(receipt.content_hash).toBe(computeContentHash(receipt));
  });

  test("handles deadlines and declared lifetime deterministically", () => {
    const deadlineSpec = spec({ terminalPredicate: () => false });
    const before = reduceMonitor(deadlineSpec, createMonitorState(deadlineSpec), {
      kind: "deadline", observedAt: "2026-08-09T12:09:59.000Z",
    });
    const expired = reduceMonitor(deadlineSpec, before.state, {
      kind: "deadline", observedAt: "2026-08-09T12:10:00.000Z",
    });
    const sessionSpec = spec({ lifetime: "session", terminalPredicate: () => false });
    const ended = reduceMonitor(sessionSpec, createMonitorState(sessionSpec), { kind: "session-ended" });

    expect(before.state.lifecycle).toBe("ACTIVE");
    expect(expired.state).toMatchObject({ lifecycle: "TERMINATING", terminalState: "INCOMPLETE" });
    expect(ended.state).toMatchObject({ lifecycle: "TERMINATING", terminalState: "CANCELLED" });
  });

  test.each([
    ["run-terminal", undefined],
    ["run-terminal", "UNKNOWN"],
    ["subject-terminal", undefined],
    ["subject-terminal", "UNKNOWN"],
  ])("rejects %s without an explicit contract terminal state (%s)", (kind, terminalState) => {
    const monitorSpec = spec({ terminalPredicate: () => false });

    expect(() => reduceMonitor(monitorSpec, createMonitorState(monitorSpec), {
      kind,
      terminalState,
    })).toThrow("terminal state");
  });

  test("rejects cancellation acknowledgement until cancellation was requested", () => {
    const monitorSpec = spec({ terminalPredicate: () => false });

    expect(() => reduceMonitor(monitorSpec, createMonitorState(monitorSpec), {
      kind: "cancel-acknowledged",
      observedAt: "2026-08-09T12:02:00.000Z",
    })).toThrow("cancellation acknowledgement");
  });

  test("bounds recent observation identity and evidence history", () => {
    const monitorSpec = spec({ maxHistory: 2, terminalPredicate: () => false });
    let state = createMonitorState(monitorSpec);
    for (let sequence = 0; sequence < 3; sequence += 1) {
      state = reduceMonitor(monitorSpec, state, {
        kind: "observation",
        event: observation(sequence, `STATE-${sequence}`, { actionability: "advisory" }),
      }).state;
    }

    expect(Object.keys(state.seenEvents)).toEqual(["event-1", "event-2"]);
    expect(state.evidenceHashes).toHaveLength(2);
  });

  test("evicts numeric event ids in insertion order", () => {
    const monitorSpec = spec({ maxHistory: 2, terminalPredicate: () => false });
    let state = createMonitorState(monitorSpec);
    for (const [sequence, eventId] of [[0, "10"], [1, "2"], [2, "1"]]) {
      state = reduceMonitor(monitorSpec, state, {
        kind: "observation",
        event: observation(sequence, `STATE-${sequence}`, {
          actionability: "advisory",
          event_id: eventId,
        }),
      }).state;
    }

    expect(state.seenEventOrder).toEqual(["2", "1"]);
    expect(Object.hasOwn(state.seenEvents, "10")).toBe(false);
    expect(Object.hasOwn(state.seenEvents, "2")).toBe(true);
    expect(Object.hasOwn(state.seenEvents, "1")).toBe(true);
  });

  test("reports the deferred transition replaced under full backpressure", () => {
    const monitorSpec = spec({ maxPending: 1, terminalPredicate: () => false });
    const first = reduceMonitor(monitorSpec, createMonitorState(monitorSpec), {
      kind: "observation", event: observation(0, "ONE"),
    });
    const second = reduceMonitor(monitorSpec, first.state, {
      kind: "observation", event: observation(1, "TWO"),
    });

    const third = reduceMonitor(monitorSpec, second.state, {
      kind: "observation", event: observation(2, "THREE"),
    });

    expect(third.state.deferred).toEqual([{ sequence: 2, eventId: "event-2" }]);
    expect(third.effects).toEqual([
      { type: "BACKPRESSURE", decision: "DROP", sequence: 1, eventId: "event-1" },
      { type: "BACKPRESSURE", decision: "DEFER", sequence: 2 },
    ]);
  });

  test("isolates prior state and events from mutating MonitorSpec callbacks", () => {
    const monitorSpec = spec({
      filter: (payload, event) => {
        payload.status = "FILTER-MUTATED";
        event.payload.type = "filter.mutated";
        return true;
      },
      reducer: (previous, payload, event) => {
        if (previous) previous.label = "PREVIOUS-MUTATED";
        event.payload.type = "reducer.mutated";
        return { label: payload.status };
      },
      terminalPredicate: (value, event) => {
        value.label = "TERMINAL-MUTATED";
        event.payload.type = "terminal.mutated";
        return false;
      },
    });
    const firstEvent = observation(0, "ONE", { actionability: "advisory" });
    const first = reduceMonitor(monitorSpec, createMonitorState(monitorSpec), {
      kind: "observation", event: firstEvent,
    });
    const priorSnapshot = structuredClone(first.state);
    const secondEvent = observation(1, "TWO", { actionability: "advisory" });

    const second = reduceMonitor(monitorSpec, first.state, { kind: "observation", event: secondEvent });

    expect(firstEvent.payload).toMatchObject({ type: "check.changed", bounded_payload: { status: "ONE" } });
    expect(secondEvent.payload).toMatchObject({ type: "check.changed", bounded_payload: { status: "TWO" } });
    expect(first.state).toEqual(priorSnapshot);
    expect(second.state.value).toEqual({ label: "TWO" });
  });

  test.each(["__proto__", "constructor"])('handles hostile event id "%s" as an own identity key', (eventId) => {
    const monitorSpec = spec({ terminalPredicate: () => false });
    const hostile = observation(0, "PENDING", { event_id: eventId, actionability: "advisory" });
    hostile.content_hash = computeContentHash(hostile);

    const first = reduceMonitor(monitorSpec, createMonitorState(monitorSpec), {
      kind: "observation", event: hostile,
    });
    const duplicate = reduceMonitor(monitorSpec, first.state, { kind: "observation", event: hostile });

    expect(Object.hasOwn(first.state.seenEvents, eventId)).toBe(true);
    expect(duplicate.effects).toEqual([]);
    expect(duplicate.modelTurns).toBe(0);
  });

  test("rejects every event after terminal cleanup", () => {
    const monitorSpec = spec({ terminalPredicate: () => false });
    const terminating = reduceMonitor(monitorSpec, createMonitorState(monitorSpec), {
      kind: "lease-lost",
    });
    const terminal = reduceMonitor(monitorSpec, terminating.state, {
      kind: "cleanup-complete", processCleanup: {}, leaseCleanup: {},
    });

    expect(() => reduceMonitor(monitorSpec, terminal.state, { kind: "observation", event: observation(0, "PENDING") })).toThrow(MonitorRuntimeError);
  });
});
