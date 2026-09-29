"use strict";

const { createHash } = require("node:crypto");

const MAX_ATTEMPTS = 128;
const MAX_ELAPSED_MS = 86_400_000;
const MAX_EVENTS = 256;
const MAX_HISTORY = 256;
const EVENT_TYPES = new Set([
  "start",
  "attempt",
  "complete",
  "fail",
  "cancel-requested",
  "cancel-acknowledged",
  "tick",
  "timeout",
]);
const TERMINAL_STATUSES = new Set(["PASS", "FAIL", "CANCELLED", "INCOMPLETE"]);
const STATE_CLONE_LIMITS = Object.freeze({ maxBytes: 4_194_304, maxDepth: 8, maxNodes: 32_768 });
const MAX_EVENT_ID_LENGTH = 128;
const EVENT_DIGEST_BYTES = 64;
const STATE_OVERHEAD_RESERVE_BYTES = 32_768;
const SEEN_EVENT_ENTRY_OVERHEAD_BYTES = (MAX_EVENT_ID_LENGTH * 6) + 2 + EVENT_DIGEST_BYTES + 2 + 3;
const EVENT_BYTE_BUDGET = Math.floor((STATE_CLONE_LIMITS.maxBytes - STATE_OVERHEAD_RESERVE_BYTES) / MAX_EVENTS)
  - SEEN_EVENT_ENTRY_OVERHEAD_BYTES;
const EVENT_CLONE_LIMITS = Object.freeze({ maxBytes: EVENT_BYTE_BUDGET, maxDepth: 8, maxNodes: 256 });

class BoundedLoopError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BoundedLoopError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new BoundedLoopError(code, message, details);
}

function ownData(value, key, name) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    fail("INVALID_INPUT", `${name || key} cannot be inspected`);
  }
  if (!descriptor || !Object.hasOwn(descriptor, "value")) {
    fail("INVALID_INPUT", `${name || key} must be a data property`);
  }
  return descriptor.value;
}

function readDescriptor(value, key, name = key) {
  try {
    return Object.getOwnPropertyDescriptor(value, key);
  } catch {
    fail("INVALID_INPUT", `${name} cannot be inspected`);
  }
}

function assertDataProperties(value, name) {
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    fail("INVALID_OPTIONS", `${name} cannot be inspected`);
  }
  for (const key of keys) {
    if (typeof key !== "string") fail("INVALID_OPTIONS", `${name} contains a symbol key`);
    const descriptor = readDescriptor(value, key, `${name}.${key}`);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) fail("INVALID_OPTIONS", `${name}.${key} must be a data property`);
  }
}

function optionalData(value, key) {
  const descriptor = readDescriptor(value, key, key);
  if (!descriptor) return { present: false, value: undefined };
  if (!Object.hasOwn(descriptor, "value")) fail("INVALID_OPTIONS", `${key} must be a data property`);
  return { present: true, value: descriptor.value };
}

function inspectCloneableObject(value) {
  let prototype;
  let keys;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    fail("INVALID_INPUT", "value cannot be inspected");
  }
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) {
    fail("INVALID_INPUT", "value must be plain data");
  }
  if (keys.some((key) => typeof key !== "string")) fail("INVALID_INPUT", "value contains a non-string key");
  return keys;
}

function cloneArray(value, keys, limits, depth, seen, maxNodes) {
  const lengthDescriptor = readDescriptor(value, "length", "array length");
  if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, "value")
    || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value > maxNodes) {
    fail("INVALID_INPUT", "array length is invalid");
  }
  const clone = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = readDescriptor(value, String(index), `array index ${index}`);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) fail("INVALID_INPUT", "array contains a hole or accessor");
    clone.push(safeClone(descriptor.value, limits, seen, depth + 1));
  }
  if (keys.length !== lengthDescriptor.value + 1) fail("INVALID_INPUT", "array contains unsupported properties");
  return clone;
}

function cloneRecord(value, keys, limits, depth, seen) {
  const clone = {};
  for (const key of keys) {
    const descriptor = readDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) fail("INVALID_INPUT", "value contains an accessor");
    Object.defineProperty(clone, key, {
      configurable: true,
      enumerable: true,
      value: safeClone(descriptor.value, limits, seen, depth + 1),
      writable: true,
    });
  }
  return clone;
}

function assertCloneSize(clone, maxBytes) {
  try {
    if (Buffer.byteLength(JSON.stringify(clone), "utf8") > maxBytes) fail("BOUNDED_INPUT", "value exceeds maximum bytes");
  } catch (error) {
    if (error instanceof BoundedLoopError) throw error;
    fail("INVALID_INPUT", "value cannot be serialized");
  }
}

function safeClone(value, limits, seen, depth = 0) {
  const cloneLimits = limits ?? {};
  const tracker = seen ?? { nodes: 0 };
  const maxDepth = cloneLimits.maxDepth ?? 8;
  const maxNodes = cloneLimits.maxNodes ?? 256;
  const maxBytes = cloneLimits.maxBytes ?? 16_384;
  if (depth > maxDepth) fail("BOUNDED_INPUT", "value exceeds maximum depth");
  tracker.nodes += 1;
  if (tracker.nodes > maxNodes) fail("BOUNDED_INPUT", "value exceeds maximum nodes");

  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("INVALID_INPUT", "non-finite numbers are not accepted");
    return value;
  }
  if (typeof value !== "object") fail("INVALID_INPUT", "functions, symbols, bigint, and undefined are not accepted");

  const keys = inspectCloneableObject(value);
  const clone = Array.isArray(value)
    ? cloneArray(value, keys, cloneLimits, depth, tracker, maxNodes)
    : cloneRecord(value, keys, cloneLimits, depth, tracker);
  assertCloneSize(clone, maxBytes);
  return clone;
}

function compareCodeUnits(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const properties = Object.keys(value)
    .sort(compareCodeUnits)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",");
  return `{${properties}}`;
}

function eventDigest(event) {
  return createHash("sha256").update(stableStringify(event), "utf8").digest("hex");
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && Object.hasOwn(descriptor, "value")) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function assertPlainRecord(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_INPUT", `${name} must be an object`);
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail("INVALID_INPUT", `${name} must be a plain object`);
  } catch {
    fail("INVALID_INPUT", `${name} cannot be inspected`);
  }
}

function assertLimit(value, name, ceiling) {
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
    fail("INVALID_LIMIT", `${name} must be a safe integer from 1 to ${ceiling}`);
  }
}

function validateLimits(options) {
  const maxAttempts = ownData(options, "maxAttempts", "maxAttempts");
  const maxElapsedMs = ownData(options, "maxElapsedMs", "maxElapsedMs");
  const maxEvents = ownData(options, "maxEvents", "maxEvents");
  const maxHistory = ownData(options, "maxHistory", "maxHistory");
  assertLimit(maxAttempts, "maxAttempts", MAX_ATTEMPTS);
  assertLimit(maxElapsedMs, "maxElapsedMs", MAX_ELAPSED_MS);
  assertLimit(maxEvents, "maxEvents", MAX_EVENTS);
  assertLimit(maxHistory, "maxHistory", MAX_HISTORY);
  if (maxHistory > maxEvents) fail("INVALID_LIMIT", "maxHistory cannot exceed maxEvents");
  return {
    maxAttempts,
    maxElapsedMs,
    maxEvents,
    maxHistory,
  };
}

function validateOptions(rawOptions) {
  assertPlainRecord(rawOptions, "options");
  assertDataProperties(rawOptions, "options");
  const loopId = ownData(rawOptions, "loopId", "loopId");
  if (typeof loopId !== "string" || loopId.length === 0 || loopId.length > 128) fail("INVALID_OPTIONS", "loopId must be a bounded string");
  const clock = ownData(rawOptions, "clock", "clock");
  if (typeof clock !== "function") fail("INVALID_OPTIONS", "clock must be an injected function");
  const limits = validateLimits({
    maxAttempts: ownData(rawOptions, "maxAttempts", "maxAttempts"),
    maxElapsedMs: ownData(rawOptions, "maxElapsedMs", "maxElapsedMs"),
    maxEvents: ownData(rawOptions, "maxEvents", "maxEvents"),
    maxHistory: ownData(rawOptions, "maxHistory", "maxHistory"),
  });
  return { loopId, clock, ...limits };
}

function readNow(options) {
  let now;
  try {
    now = options.now === undefined ? options.clock() : options.now;
  } catch {
    fail("CLOCK_FAILURE", "injected clock failed");
  }
  if (!Number.isSafeInteger(now) || now < 0) fail("CLOCK_INVALID", "injected clock must return a non-negative safe integer");
  return now;
}

function normalizeEvent(rawEvent) {
  const event = safeClone(rawEvent, EVENT_CLONE_LIMITS);
  assertPlainRecord(event, "event");
  if (typeof event.id !== "string" || event.id.length === 0 || event.id.length > 128) fail("INVALID_EVENT", "event id must be a bounded string");
  if (!EVENT_TYPES.has(event.type)) fail("INVALID_EVENT", `unsupported bounded-loop event: ${String(event.type)}`);
  if (event.amount !== undefined && (!Number.isSafeInteger(event.amount) || event.amount < 1)) {
    fail("INVALID_EVENT", "event amount must be a positive safe integer");
  }
  if (event.status !== undefined && !TERMINAL_STATUSES.has(event.status)) fail("INVALID_EVENT", "event status is invalid");
  if (event.reason !== undefined && (typeof event.reason !== "string" || event.reason.length > 256)) fail("INVALID_EVENT", "event reason is invalid");
  if (event.at !== undefined && (!Number.isSafeInteger(event.at) || event.at < 0)) fail("INVALID_EVENT", "event timestamp is invalid");
  return event;
}

function cloneResult(state, effects) {
  return {
    state: deepFreeze(safeClone(state, STATE_CLONE_LIMITS)),
    effects: deepFreeze(safeClone(effects)),
  };
}

function createState(loopId, now) {
  return {
    loopId,
    phase: "READY",
    status: "PENDING",
    terminal: false,
    terminalReason: null,
    attempts: 0,
    elapsedMs: 0,
    startAt: null,
    lastAt: now,
    eventCount: 0,
    history: [],
    seenEvents: {},
  };
}

function createBoundedLoopState(rawOptions, now = 0) {
  const options = validateOptions(rawOptions);
  if (!Number.isSafeInteger(now) || now < 0) fail("CLOCK_INVALID", "initial time is invalid");
  return createState(options.loopId, now);
}

function terminal(state, status, reason, effect) {
  const next = { ...state, phase: "TERMINAL", status, terminal: true, terminalReason: reason };
  return { state: next, effects: effect ? [effect] : [] };
}

function duplicateEventResult(state, event) {
  if (!Object.hasOwn(state.seenEvents || {}, event.id)) return null;
  if (state.seenEvents[event.id] !== eventDigest(event)) fail("IDENTITY_CONFLICT", "event identity conflict");
  return cloneResult(state, []);
}

function assertReducibleState(state, maxEvents) {
  if (state.terminal || state.phase === "TERMINAL") fail("POST_TERMINAL_EVENT", "post-terminal event is rejected");
  if (!Number.isSafeInteger(state.eventCount) || state.eventCount < 0) fail("INVALID_STATE", "event count is invalid");
  if (state.eventCount >= maxEvents) fail("EVENT_CAP_EXCEEDED", "bounded-loop event cap exceeded");
}

function resolveReducerTime(state, event, suppliedNow) {
  if (suppliedNow.present && typeof suppliedNow.value !== "number" && suppliedNow.value !== undefined) {
    fail("CLOCK_INVALID", "reducer time is invalid");
  }
  const now = suppliedNow.value === undefined ? (event.at ?? state.lastAt) : suppliedNow.value;
  if (!Number.isSafeInteger(now) || now < 0) fail("CLOCK_INVALID", "reducer time is invalid");
  if (event.at !== undefined && suppliedNow.value !== undefined && event.at !== now) fail("NON_MONOTONIC_INPUT", "event timestamp does not match injected clock");
  if (state.lastAt !== null && (!Number.isSafeInteger(state.lastAt) || now < state.lastAt)) {
    fail("NON_MONOTONIC_CLOCK", "injected clock is non-monotonic");
  }
  return now;
}

function advanceState(state, event, limits, now) {
  const seen = state.seenEvents || {};
  const next = {
    ...state,
    lastAt: now,
    eventCount: state.eventCount + 1,
    history: [...(state.history || []), event].slice(-limits.maxHistory),
    seenEvents: { ...seen, [event.id]: eventDigest(event) },
  };
  if (next.startAt === null) return next;
  const elapsed = now - next.startAt;
  if (!Number.isSafeInteger(elapsed) || elapsed < 0) fail("ELAPSED_OVERFLOW", "elapsed time overflow");
  next.elapsedMs = elapsed;
  return next;
}

function startTransition(state, next, now, invalidPhase) {
  if (state.phase !== "READY") invalidPhase("READY phase");
  next.phase = "RUNNING";
  next.status = "RUNNING";
  next.startAt = now;
  next.attempts = 1;
  return { state: next, effects: [{ type: "START" }] };
}

function attemptTransition(state, next, event, limits, invalidPhase) {
  if (state.phase !== "RUNNING") invalidPhase("RUNNING phase");
  next.attempts += event.amount ?? 1;
  if (!Number.isSafeInteger(next.attempts) || next.attempts > limits.maxAttempts) {
    return terminal(next, "INCOMPLETE", "ATTEMPT_CAP", { type: "ATTEMPT_CAP", attempts: next.attempts });
  }
  return { state: next, effects: [{ type: "ATTEMPT", attempts: next.attempts }] };
}

function completeTransition(state, next, event, invalidPhase) {
  if (state.phase !== "RUNNING") invalidPhase("RUNNING phase");
  if (event.status !== undefined && !["PASS", "FAIL"].includes(event.status)) fail("INVALID_EVENT", "complete status must be PASS or FAIL");
  return terminal(next, event.status ?? "PASS", event.reason ?? null, { type: "COMPLETE", status: event.status ?? "PASS" });
}

function cancelTransition(state, next, invalidPhase) {
  if (state.phase !== "RUNNING") invalidPhase("RUNNING phase");
  next.phase = "CANCEL_REQUESTED";
  next.status = "CANCELLING";
  return { state: next, effects: [{ type: "CANCEL" }] };
}

function timeoutTransition(state, next, limits, invalidPhase) {
  if (!["RUNNING", "CANCEL_REQUESTED"].includes(state.phase)) invalidPhase("RUNNING or CANCEL_REQUESTED phase");
  if (next.elapsedMs >= limits.maxElapsedMs) {
    return terminal(next, "INCOMPLETE", "ELAPSED_CAP", { type: "TIMEOUT", elapsedMs: next.elapsedMs });
  }
  return { state: next, effects: [] };
}

function applyBoundedEvent(state, next, event, limits, now) {
  const invalidPhase = (expected) => fail("INVALID_TRANSITION", `${event.type} requires ${expected}`);
  switch (event.type) {
    case "start":
      return startTransition(state, next, now, invalidPhase);
    case "attempt":
      return attemptTransition(state, next, event, limits, invalidPhase);
    case "complete":
      return completeTransition(state, next, event, invalidPhase);
    case "fail":
      if (state.phase !== "RUNNING") invalidPhase("RUNNING phase");
      return terminal(next, "FAIL", event.reason ?? "FAILURE", { type: "FAIL", reason: event.reason ?? "FAILURE" });
    case "cancel-requested":
      return cancelTransition(state, next, invalidPhase);
    case "cancel-acknowledged":
      if (state.phase !== "CANCEL_REQUESTED") invalidPhase("CANCEL_REQUESTED phase");
      return terminal(next, "CANCELLED", "CANCEL_ACKNOWLEDGED", { type: "CANCEL_ACKNOWLEDGED" });
    case "tick":
    case "timeout":
      return timeoutTransition(state, next, limits, invalidPhase);
    default:
      fail("INVALID_EVENT", `unsupported bounded-loop event: ${event.type}`);
  }
}

function reduceBoundedLoop(rawState, rawEvent, rawOptions = {}) {
  assertPlainRecord(rawState, "state");
  const event = normalizeEvent(rawEvent);
  const state = safeClone(rawState, STATE_CLONE_LIMITS);
  assertPlainRecord(rawOptions, "options");
  assertDataProperties(rawOptions, "options");
  const limits = validateLimits(rawOptions);
  const suppliedNow = optionalData(rawOptions, "now");
  if (suppliedNow.present && typeof suppliedNow.value !== "number" && suppliedNow.value !== undefined) {
    fail("CLOCK_INVALID", "reducer time is invalid");
  }
  const duplicate = duplicateEventResult(state, event);
  if (duplicate) return duplicate;
  assertReducibleState(state, limits.maxEvents);
  const now = resolveReducerTime(state, event, suppliedNow);
  const next = advanceState(state, event, limits, now);
  const elapsedCapReached = event.type !== "start"
    && next.startAt !== null
    && next.elapsedMs >= limits.maxElapsedMs;
  let result = applyBoundedEvent(state, next, event, limits, now);
  if ((elapsedCapReached && !result.state.terminal) || event.type === "timeout") {
    result = terminal(next, "INCOMPLETE", "ELAPSED_CAP", { type: "TIMEOUT", elapsedMs: next.elapsedMs });
  }
  return cloneResult(result.state, result.effects);
}

function createBoundedLoop(rawOptions) {
  const options = validateOptions(rawOptions);
  // The first injected clock read belongs to the first transition. Construction is inert.
  let current = createState(options.loopId, 0);
  return Object.freeze({
    dispatch(rawEvent) {
      const event = normalizeEvent(rawEvent);
      const digest = eventDigest(event);
      if (Object.hasOwn(current.seenEvents, event.id)) {
        const existing = current.seenEvents[event.id];
        if (existing !== digest) fail("IDENTITY_CONFLICT", "event identity conflict");
        return cloneResult(current, []);
      }
      const now = readNow(options);
      const result = reduceBoundedLoop(current, event, { ...options, now });
      current = result.state;
      return result;
    },
    snapshot() {
      return deepFreeze(safeClone(current, STATE_CLONE_LIMITS));
    },
    serialize() {
      return stableStringify(safeClone(current, STATE_CLONE_LIMITS));
    },
  });
}

module.exports = {
  BoundedLoopError,
  MAX_ATTEMPTS,
  EVENT_BYTE_BUDGET,
  MAX_ELAPSED_MS,
  MAX_EVENTS,
  MAX_HISTORY,
  createBoundedLoop,
  createBoundedLoopState,
  reduceBoundedLoop,
};
