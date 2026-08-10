"use strict";

const {
  canonicalize,
  computeContentHash,
  validateContract,
  validateContractStructure,
} = require("@forge/memory-contracts");

const LIFETIMES = new Set(["session", "run", "subject"]);
const TERMINAL_STATES = new Set(["PASS", "FAIL", "INCOMPLETE", "CANCELLED"]);
const MAX_HISTORY = 128;
const MAX_LIST_ITEMS = 128;
const MAX_PENDING = 128;
const MAX_RETRIES = 32;
const MAX_PAYLOAD_BYTES = 16_384;

class MonitorRuntimeError extends Error {
  constructor(code, message, details = []) {
    super(message);
    this.name = "MonitorRuntimeError";
    this.code = code;
    this.details = details;
  }
}

function nonEmptyString(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function validateStringList(value, name) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LIST_ITEMS) {
    throw new TypeError(`${name} must contain 1 to ${MAX_LIST_ITEMS} items`);
  }
  for (const item of value) nonEmptyString(item, `${name} item`);
}

function validateSpec(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new TypeError("MonitorSpec must be an object");
  nonEmptyString(spec.monitorId, "monitorId");
  nonEmptyString(spec.ownerRunId, "ownerRunId");
  nonEmptyString(spec.packetId, "packetId");
  nonEmptyString(spec.subject?.id, "subject.id");
  nonEmptyString(spec.subject?.revision, "subject.revision");
  validateStringList(spec.sourceAdapters, "sourceAdapters");
  validateStringList(spec.deliveryTargets, "deliveryTargets");
  if (!LIFETIMES.has(spec.lifetime)) throw new TypeError("lifetime is invalid");
  if (typeof spec.deadline !== "string" || Number.isNaN(Date.parse(spec.deadline))) throw new TypeError("deadline is invalid");
  if (typeof spec.reducer !== "function" || typeof spec.terminalPredicate !== "function") throw new TypeError("reducer and terminalPredicate are required");
  if (spec.filter !== undefined && typeof spec.filter !== "function") throw new TypeError("filter must be a function");
  if (!Number.isSafeInteger(spec.maxPending) || spec.maxPending < 1 || spec.maxPending > MAX_PENDING) {
    throw new TypeError(`maxPending must be an integer from 1 to ${MAX_PENDING}`);
  }
  if (!Number.isSafeInteger(spec.maxRetries) || spec.maxRetries < 0 || spec.maxRetries > MAX_RETRIES) {
    throw new TypeError(`maxRetries must be an integer from 0 to ${MAX_RETRIES}`);
  }
  if (!Number.isSafeInteger(spec.retryBaseMs) || spec.retryBaseMs < 1) throw new TypeError("retryBaseMs must be a positive safe integer");
  const maximumRetryDelay = spec.retryBaseMs * (2 ** Math.max(0, spec.maxRetries - 1));
  if (!Number.isSafeInteger(maximumRetryDelay)) throw new TypeError("retry delay exceeds the safe integer ceiling");
  if (!spec.securityPolicy || typeof spec.securityPolicy !== "object" || Array.isArray(spec.securityPolicy)
    || !Number.isSafeInteger(spec.securityPolicy.maxPayloadBytes)
    || spec.securityPolicy.maxPayloadBytes < 1
    || spec.securityPolicy.maxPayloadBytes > MAX_PAYLOAD_BYTES) {
    throw new TypeError(`securityPolicy.maxPayloadBytes must be an integer from 1 to ${MAX_PAYLOAD_BYTES}`);
  }
  if (spec.maxHistory !== undefined
    && (!Number.isInteger(spec.maxHistory) || spec.maxHistory < 1 || spec.maxHistory > MAX_HISTORY)) {
    throw new TypeError("maxHistory must be an integer from 1 to 128");
  }
}

function createMonitorState(spec) {
  validateSpec(spec);
  return {
    monitorId: spec.monitorId,
    ownerRunId: spec.ownerRunId,
    lifecycle: "ACTIVE",
    value: undefined,
    valueDigest: undefined,
    lastSequence: -1,
    acknowledgementCursor: -1,
    seenEvents: Object.create(null),
    evidenceHashes: [],
    pending: [],
    deferred: [],
    retryCounts: {},
    cancellationRequested: false,
    cancellationAcknowledged: false,
    terminalState: undefined,
    terminalReason: undefined,
    processCleanup: undefined,
    leaseCleanup: undefined,
    undeliveredCursor: undefined,
  };
}

function result(state, effects = [], modelTurns = 0) {
  return { state, effects, modelTurns };
}

function terminating(state, terminalState, terminalReason, extra = {}) {
  const undelivered = [...state.pending, ...state.deferred];
  return result({
    ...state,
    ...extra,
    lifecycle: "TERMINATING",
    terminalState,
    terminalReason,
    undeliveredCursor: undelivered.length === 0
      ? undefined
      : Math.min(...undelivered.map((item) => item.sequence)),
  }, [{ type: "CLEANUP_PROCESS" }, { type: "CLEANUP_LEASE" }]);
}

function validateObservation(spec, event) {
  const validation = validateContract(event, {
    expected: { monitorId: spec.monitorId, subjectRevision: spec.subject.revision },
  });
  if (event?.schema_id !== "forge.memory.monitor-event.v1" || !validation.ok) {
    throw new MonitorRuntimeError("INVALID_OBSERVATION", "MonitorEvent validation failed", validation.errors);
  }
  const configuredLimit = spec.securityPolicy?.maxPayloadBytes;
  if (configuredLimit !== undefined) {
    const bytes = Buffer.byteLength(canonicalize(event.payload.bounded_payload ?? {}), "utf8");
    if (bytes > configuredLimit) throw new MonitorRuntimeError("INVALID_OBSERVATION", "MonitorEvent exceeds security policy");
  }
}

function callbackClone(spec, value) {
  if (value === undefined) return undefined;
  try {
    const clone = structuredClone(value);
    canonicalize(clone, {
      maxBytes: spec.securityPolicy?.maxPayloadBytes ?? 16_384,
      maxDepth: 8,
      maxNodes: 128,
    });
    return clone;
  } catch {
    throw new MonitorRuntimeError("INVALID_CALLBACK_VALUE", "Monitor callback value exceeds bounds");
  }
}

function callbackBoolean(name, callback, ...args) {
  let decision;
  try {
    decision = callback(...args);
  } catch {
    throw new MonitorRuntimeError("CALLBACK_FAILURE", `${name} failed`);
  }
  if (typeof decision !== "boolean") {
    throw new MonitorRuntimeError("INVALID_CALLBACK_DECISION", `${name} must return a synchronous boolean`);
  }
  return decision;
}

function cloneIdentityMap(source) {
  const clone = Object.create(null);
  for (const key of Object.keys(source)) {
    Object.defineProperty(clone, key, {
      value: structuredClone(source[key]),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return clone;
}

function reduceObservation(spec, state, event) {
  validateObservation(spec, event);
  const payload = event.payload;
  const seen = Object.hasOwn(state.seenEvents, payload.event_id)
    ? state.seenEvents[payload.event_id]
    : undefined;
  if (seen !== undefined) {
    if (seen.sequence !== payload.sequence || seen.contentHash !== event.content_hash) {
      throw new MonitorRuntimeError("IDENTITY_CONFLICT", "MonitorEvent identity conflict");
    }
    return result(state);
  }
  if (payload.sequence <= state.lastSequence) {
    throw new MonitorRuntimeError("OUT_OF_ORDER", "MonitorEvent sequence is not monotonic");
  }

  const next = structuredClone(state);
  next.seenEvents = cloneIdentityMap(state.seenEvents);
  Object.defineProperty(next.seenEvents, payload.event_id, {
    value: { sequence: payload.sequence, contentHash: event.content_hash },
    enumerable: true,
    configurable: true,
    writable: true,
  });
  next.evidenceHashes.push(event.content_hash);
  const maxHistory = spec.maxHistory ?? MAX_HISTORY;
  while (Object.keys(next.seenEvents).length > maxHistory) {
    delete next.seenEvents[Object.keys(next.seenEvents)[0]];
  }
  if (next.evidenceHashes.length > maxHistory) {
    next.evidenceHashes.splice(0, next.evidenceHashes.length - maxHistory);
  }
  next.lastSequence = payload.sequence;
  if (spec.filter && !callbackBoolean("filter", spec.filter,
    callbackClone(spec, payload.bounded_payload ?? {}),
    callbackClone(spec, event),
  )) return result(next);

  const nextValue = callbackClone(spec, spec.reducer(
    callbackClone(spec, state.value),
    callbackClone(spec, payload.bounded_payload ?? {}),
    callbackClone(spec, event),
  ));
  const nextDigest = computeContentHash({ value: nextValue });
  const changed = nextDigest !== state.valueDigest;
  next.value = structuredClone(nextValue);
  next.valueDigest = nextDigest;
  if (!changed) return result(next);

  const terminal = callbackBoolean("terminalPredicate", spec.terminalPredicate,
    callbackClone(spec, nextValue),
    callbackClone(spec, event),
  );
  if (terminal) {
    const terminalState = nextValue === "FAIL" ? "FAIL" : "PASS";
    return terminating(next, terminalState, "terminal predicate satisfied");
  }
  if (payload.actionability === "advisory") return result(next);
  if (next.pending.length >= spec.maxPending) {
    const deferred = { sequence: payload.sequence, eventId: payload.event_id };
    if (next.deferred.length < spec.maxPending) next.deferred.push(deferred);
    else next.deferred[next.deferred.length - 1] = deferred;
    return result(next, [{ type: "BACKPRESSURE", decision: "DEFER", sequence: payload.sequence }]);
  }
  next.pending.push({ sequence: payload.sequence, eventId: payload.event_id });
  return result(next, [{
    type: "DELIVER",
    eventId: payload.event_id,
    sequence: payload.sequence,
    targets: [...spec.deliveryTargets],
  }], 1);
}

function reduceAcknowledgement(spec, state, event) {
  if (!Number.isInteger(event.sequence) || event.sequence < state.acknowledgementCursor || event.sequence > state.lastSequence) {
    throw new MonitorRuntimeError("INVALID_ACKNOWLEDGEMENT", "Invalid acknowledgement cursor");
  }
  if (event.sequence === state.acknowledgementCursor) return result(state);
  if (!state.pending.some((item) => item.sequence === event.sequence)) {
    throw new MonitorRuntimeError("INVALID_ACKNOWLEDGEMENT", "Invalid acknowledgement cursor");
  }
  const next = structuredClone(state);
  next.acknowledgementCursor = event.sequence;
  next.pending = next.pending.filter((item) => item.sequence > event.sequence);
  for (const sequence of Object.keys(next.retryCounts)) {
    if (Number(sequence) <= event.sequence) delete next.retryCounts[sequence];
  }
  const effects = [];
  while (next.pending.length < spec.maxPending && next.deferred.length > 0) {
    const delivery = next.deferred.shift();
    next.pending.push(delivery);
    effects.push({
      type: "DELIVER",
      eventId: delivery.eventId,
      sequence: delivery.sequence,
      targets: [...spec.deliveryTargets],
    });
  }
  return result(next, effects, effects.length);
}

function reduceDeliveryFailure(spec, state, event) {
  if (!Number.isInteger(event.sequence) || !state.pending.some((item) => item.sequence === event.sequence)) {
    throw new MonitorRuntimeError("INVALID_RETRY", "Retry does not reference pending delivery");
  }
  const next = structuredClone(state);
  const attempts = (next.retryCounts[event.sequence] ?? 0) + 1;
  next.retryCounts[event.sequence] = attempts;
  if (attempts > spec.maxRetries) return terminating(next, "INCOMPLETE", "delivery retries exhausted");
  const delayMs = spec.retryBaseMs * (2 ** (attempts - 1));
  if (!Number.isSafeInteger(delayMs)) return terminating(next, "INCOMPLETE", "delivery retry delay overflow");
  return result(next, [{
    type: "RETRY_DELIVERY",
    sequence: event.sequence,
    attempt: attempts,
    delayMs,
    observedAt: nonEmptyString(event.observedAt, "observedAt"),
  }]);
}

function reduceActive(spec, state, event) {
  switch (event.kind) {
    case "observation": return reduceObservation(spec, state, event.event);
    case "acknowledge": return reduceAcknowledgement(spec, state, event);
    case "delivery-failed": return reduceDeliveryFailure(spec, state, event);
    case "cancel-requested":
      return result({ ...state, cancellationRequested: true }, [{ type: "CANCEL_SOURCE" }]);
    case "cancel-acknowledged":
      if (!state.cancellationRequested) {
        throw new MonitorRuntimeError("UNREQUESTED_CANCELLATION_ACK", "Invalid cancellation acknowledgement");
      }
      return terminating(state, "CANCELLED", "cancellation acknowledged", { cancellationAcknowledged: true });
    case "deadline":
      return Date.parse(nonEmptyString(event.observedAt, "observedAt")) < Date.parse(spec.deadline)
        ? result(state)
        : terminating(state, "INCOMPLETE", "deadline exceeded");
    case "session-ended":
      return spec.lifetime === "session" ? terminating(state, "CANCELLED", "session lifetime ended") : result(state);
    case "run-terminal": {
      if (spec.lifetime !== "run") return result(state);
      if (!TERMINAL_STATES.has(event.terminalState)) {
        throw new MonitorRuntimeError("INVALID_TERMINAL_STATE", "Invalid terminal state");
      }
      return terminating(state, event.terminalState, "owner run terminal");
    }
    case "subject-terminal": {
      if (!TERMINAL_STATES.has(event.terminalState)) {
        throw new MonitorRuntimeError("INVALID_TERMINAL_STATE", "Invalid terminal state");
      }
      return terminating(state, event.terminalState, "subject terminal");
    }
    case "lease-lost": return terminating(state, "INCOMPLETE", "lease lost");
    default: throw new MonitorRuntimeError("UNKNOWN_EVENT", `Unsupported monitor event: ${event.kind}`);
  }
}

function reduceMonitor(spec, state, event) {
  validateSpec(spec);
  if (!state || state.monitorId !== spec.monitorId || state.ownerRunId !== spec.ownerRunId) {
    throw new MonitorRuntimeError("STATE_MISMATCH", "Monitor state does not match MonitorSpec");
  }
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new MonitorRuntimeError("INVALID_EVENT", "Monitor event is invalid");
  if (state.lifecycle === "TERMINAL") throw new MonitorRuntimeError("POST_TERMINAL_EVENT", "Monitor rejects post-terminal events");
  if (state.lifecycle === "TERMINATING") {
    if (event.kind !== "cleanup-complete") throw new MonitorRuntimeError("TERMINATING_EVENT", "Monitor accepts only cleanup completion while terminating");
    if (!event.processCleanup || typeof event.processCleanup !== "object" || !event.leaseCleanup || typeof event.leaseCleanup !== "object") {
      throw new MonitorRuntimeError("INVALID_CLEANUP", "Cleanup proof is required");
    }
    return result({
      ...state,
      lifecycle: "TERMINAL",
      processCleanup: structuredClone(event.processCleanup),
      leaseCleanup: structuredClone(event.leaseCleanup),
    }, [{ type: "ISSUE_MONITOR_RECEIPT" }]);
  }
  return reduceActive(spec, state, event);
}

function createMonitorReceipt(spec, state, options = {}) {
  validateSpec(spec);
  if (state?.lifecycle !== "TERMINAL") throw new MonitorRuntimeError("NOT_TERMINAL", "Monitor is not ready for a receipt");
  const producerInstanceId = nonEmptyString(options.producerInstanceId, "producerInstanceId");
  const payload = {
    monitor_id: spec.monitorId,
    owner_run_id: spec.ownerRunId,
    terminal_state: state.terminalState,
    terminal_reason: state.terminalReason,
    last_sequence: Math.max(0, state.lastSequence),
    evidence_digest: computeContentHash({ evidence_hashes: state.evidenceHashes }),
    cancellation_acknowledged: state.cancellationAcknowledged,
    process_cleanup: structuredClone(state.processCleanup),
    lease_cleanup: structuredClone(state.leaseCleanup),
  };
  if (state.undeliveredCursor !== undefined) payload.undelivered_cursor = state.undeliveredCursor;
  const receipt = {
    schema_id: "forge.memory.monitor-receipt.v1",
    schema_version: 1,
    object_id: nonEmptyString(options.objectId, "objectId"),
    created_at: nonEmptyString(options.createdAt, "createdAt"),
    producer: { product_id: "forge-flow", product_version: "0.1.0-beta.6", instance_id: producerInstanceId },
    capabilities_used: [],
    provenance: { source_kind: "monitor", actor_class: "system", actor_id: producerInstanceId },
    payload,
    extensions: {},
  };
  receipt.content_hash = computeContentHash(receipt);
  const validation = validateContractStructure(receipt);
  if (!validation.ok) throw new MonitorRuntimeError("INVALID_RECEIPT", "MonitorReceipt validation failed", validation.errors);
  return receipt;
}

module.exports = { MonitorRuntimeError, createMonitorReceipt, createMonitorState, reduceMonitor };
