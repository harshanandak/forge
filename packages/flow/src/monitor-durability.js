"use strict";

const { types } = require("node:util");
const {
  canonicalize,
  computeContentHash,
  validateContractStructure,
} = require("@forge/memory-contracts");

const MAX_EVIDENCE_HISTORY = 128;
const MAX_INPUT_BYTES = 1_048_576;
const MAX_MONITOR_ID_LENGTH = 128;
const SHA256 = /^[0-9a-f]{64}$/;
const TARGET = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

class MonitorDurabilityError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "MonitorDurabilityError";
    this.code = code;
    Object.assign(this, details);
  }
}

function fail(code, message, details) {
  throw new MonitorDurabilityError(code, message, details);
}

function ownValue(object, field) {
  if (!object || typeof object !== "object" || types.isProxy(object)) {
    fail("INVALID_CONFIGURATION", "Monitor durability configuration must be a plain object");
  }
  const descriptor = Object.getOwnPropertyDescriptor(object, field);
  if (!descriptor || !Object.hasOwn(descriptor, "value")) {
    fail("INVALID_CONFIGURATION", `Monitor durability configuration requires ${field}`);
  }
  return descriptor.value;
}

function assertMethod(object, field) {
  const method = ownValue(object, field);
  if (typeof method !== "function") {
    fail("INVALID_CONFIGURATION", `Monitor store requires ${field}()`);
  }
  return method.bind(object);
}

function snapshotCanonical(value, label) {
  try {
    return JSON.parse(canonicalize(value, {
      maxDepth: 64,
      maxNodes: 100_000,
      maxBytes: MAX_INPUT_BYTES,
    }));
  } catch {
    fail("INPUT_INVALID", `${label} must be bounded canonical data`);
  }
}

function immutableSnapshot(value, label) {
  const snapshot = snapshotCanonical(value, label);
  const freeze = (current) => {
    if (!current || typeof current !== "object" || Object.isFrozen(current)) return current;
    Object.freeze(current);
    for (const child of Object.values(current)) freeze(child);
    return current;
  };
  return freeze(snapshot);
}

function assertMonitorId(value) {
  const snapshot = snapshotCanonical(value, "monitorId");
  if (typeof snapshot !== "string" || snapshot.length === 0 || snapshot.length > MAX_MONITOR_ID_LENGTH) {
    fail("INPUT_INVALID", "monitorId must be a bounded canonical string");
  }
  return snapshot;
}

function assertEnvelope(value, schemaId) {
  const snapshot = snapshotCanonical(value, schemaId);
  let validation;
  try {
    validation = validateContractStructure(snapshot);
  } catch {
    fail("INPUT_INVALID", `${schemaId} structure validation failed`);
  }
  if (!validation?.ok) {
    fail("INPUT_INVALID", `${schemaId} structure validation failed`, {
      errors: validation?.errors,
    });
  }
  const computedHash = computeContentHash(snapshot);
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    snapshot.schema_id !== schemaId ||
    !snapshot.payload ||
    typeof snapshot.payload !== "object" ||
    snapshot.content_hash !== computedHash
  ) {
    fail("INPUT_INVALID", `${schemaId} identity validation failed`, {
      actualHash: snapshot?.content_hash,
      computedHash,
    });
  }
  if (schemaId === "forge.memory.monitor-event.v1" || schemaId === "forge.memory.monitor-receipt.v1") {
    assertMonitorId(snapshot.payload.monitor_id);
  }
  return snapshot;
}

function assertTargets(value) {
  const snapshot = snapshotCanonical(value, "deliveryTargets");
  if (
    !Array.isArray(snapshot) ||
    snapshot.length === 0 ||
    snapshot.length > 32 ||
    snapshot.some((target) => (
      typeof target !== "string" ||
      target.length === 0 ||
      target.length > 128 ||
      !TARGET.test(target)
    ))
  ) {
    fail("INVALID_CONFIGURATION", "deliveryTargets must contain 1-32 entries");
  }
  return Object.freeze([...new Set(snapshot)]);
}

function readProviderCode(error) {
  if (
    (typeof error !== "object" && typeof error !== "function") ||
    error === null ||
    types.isProxy(error)
  ) {
    return "";
  }
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(error, "code");
  } catch {
    return "";
  }
  return descriptor && Object.hasOwn(descriptor, "value") && typeof descriptor.value === "string"
    ? descriptor.value
    : "";
}

function mapProviderFailure(error) {
  const code = readProviderCode(error);
  if ([
    "MONITOR_EVENT_CONFLICT",
    "MONITOR_TARGET_SET_CONFLICT",
    "MONITOR_DELIVERY_CONFLICT",
    "MONITOR_RECEIPT_CONFLICT",
  ].includes(code)) {
    return new MonitorDurabilityError("IDENTITY_CONFLICT", "Monitor identity/content conflict");
  }
  if (code === "MONITOR_STALE_CURSOR") {
    return new MonitorDurabilityError("STALE_CURSOR", "Monitor delivery cursor is stale");
  }
  if (code === "MONITOR_STALE_TERMINAL") {
    return new MonitorDurabilityError(
      "INCOMPLETE_TERMINAL_EVIDENCE",
      "Monitor terminal evidence is stale",
    );
  }
  if (code === "MONITOR_TERMINAL") {
    return new MonitorDurabilityError("TERMINAL_FENCED", "Monitor is already terminal");
  }
  return new MonitorDurabilityError("PROVIDER_UNAVAILABLE", "Monitor durability provider unavailable");
}

async function providerCall(operation) {
  try {
    return await operation();
  } catch (error) {
    throw mapProviderFailure(error);
  }
}

function assertRows(
  value,
  monitorId,
  limit = MAX_EVIDENCE_HISTORY,
  code = "INCOMPLETE_TERMINAL_EVIDENCE",
) {
  if (!Array.isArray(value) || value.length > limit) {
    fail(code, "Monitor event history is unavailable or exceeds its bound");
  }
  const rows = value.map((row) => {
    if (
      !row ||
      typeof row !== "object" ||
      row.monitor_id !== monitorId ||
      !Number.isSafeInteger(row.sequence) ||
      row.sequence < 0 ||
      typeof row.event_id !== "string" ||
      !SHA256.test(row.content_hash)
    ) {
      fail(code, "Monitor event history is incomplete");
    }
    return row;
  });
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index].sequence <= rows[index - 1].sequence) {
      fail(code, "Monitor event history is not monotonic");
    }
  }
  return rows;
}

function assertEvent(value, monitorId, eventId) {
  const snapshot = snapshotCanonical(value, "monitor event");
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    snapshot.monitor_id !== monitorId ||
    snapshot.event_id !== eventId
  ) {
    fail("INPUT_INVALID", "Delivery receipt references an unknown monitor event");
  }
  const [event] = assertRows([snapshot], monitorId, 1, "INPUT_INVALID");
  return event;
}

function assertTail(value, monitorId, maxHistory) {
  const snapshot = snapshotCanonical(value, "monitor event tail");
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot) ||
    typeof snapshot.overflow !== "boolean"
  ) {
    fail("INCOMPLETE_TERMINAL_EVIDENCE", "Monitor event tail is incomplete");
  }
  const rows = assertRows(snapshot.events, monitorId, maxHistory);
  const expectedTruncation = snapshot.overflow && rows.length > 0 ? rows[0].sequence : null;
  if (
    (snapshot.overflow && rows.length !== maxHistory) ||
    snapshot.truncated_before_sequence !== expectedTruncation
  ) {
    fail("INCOMPLETE_TERMINAL_EVIDENCE", "Monitor event tail overflow metadata is inconsistent");
  }
  return rows;
}

function assertDeliveryState(value, monitorId) {
  const snapshot = snapshotCanonical(value, "monitor delivery state");
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot) ||
    !Array.isArray(snapshot.cursors) ||
    !Array.isArray(snapshot.outbox) ||
    !snapshot.overflow ||
    typeof snapshot.overflow.cursors !== "boolean" ||
    typeof snapshot.overflow.outbox !== "boolean"
  ) {
    fail("PROVIDER_UNAVAILABLE", "Monitor delivery state is incomplete");
  }
  if (snapshot.overflow.cursors) {
    fail("PROVIDER_UNAVAILABLE", "Monitor delivery cursor state exceeds its bound");
  }
  const cursors = snapshot.cursors.map((cursor) => {
    if (
      !cursor ||
      typeof cursor !== "object" ||
      cursor.monitor_id !== monitorId ||
      typeof cursor.target !== "string" ||
      !Number.isSafeInteger(cursor.sequence) ||
      cursor.sequence < 0
    ) {
      fail("PROVIDER_UNAVAILABLE", "Monitor delivery cursor state is incomplete");
    }
    return cursor;
  });
  const terminal = snapshot.terminal_receipt;
  if (
    terminal !== null && (
      !terminal ||
      typeof terminal !== "object" ||
      terminal.monitor_id !== monitorId ||
      !SHA256.test(terminal.content_hash) ||
      typeof terminal.envelope_json !== "string"
    )
  ) {
    fail("PROVIDER_UNAVAILABLE", "Monitor terminal state is incomplete");
  }
  return { cursors, terminal };
}

function assertHistoryWidth(config) {
  const maxHistory = Object.hasOwn(config, "maxHistory") ? config.maxHistory : MAX_EVIDENCE_HISTORY;
  if (!Number.isSafeInteger(maxHistory) || maxHistory < 1 || maxHistory > MAX_EVIDENCE_HISTORY) {
    fail("INPUT_INVALID", `maxHistory must be an integer from 1 to ${MAX_EVIDENCE_HISTORY}`);
  }
  return maxHistory;
}

function assertTerminalEvidence(receipt, rows, maxHistory) {
  const terminalState = receipt.payload.terminal_state;
  if (terminalState !== "PASS" && terminalState !== "FAIL") return;
  const evidenceRows = rows.slice(-maxHistory);
  const digest = computeContentHash({ evidence_hashes: evidenceRows.map((row) => row.content_hash) });
  if (rows.length === 0) {
    if (terminalState === "FAIL" && receipt.payload.last_sequence === 0 && receipt.payload.evidence_digest === digest) {
      return;
    }
    fail("INCOMPLETE_TERMINAL_EVIDENCE", `${terminalState} receipt does not cover durable monitor events`);
  }
  if (rows.at(-1).sequence !== receipt.payload.last_sequence) {
    fail("INCOMPLETE_TERMINAL_EVIDENCE", `${terminalState} receipt does not cover durable monitor events`);
  }
  if (digest !== receipt.payload.evidence_digest) {
    fail("INCOMPLETE_TERMINAL_EVIDENCE", `${terminalState} receipt evidence digest is incomplete`);
  }
}

function createMonitorDurabilityBridge(options) {
  const store = ownValue(options, "store");
  const appendEvent = assertMethod(store, "appendEvent");
  const recordDeliveryReceipt = assertMethod(store, "recordDeliveryReceipt");
  const recordTerminalReceipt = assertMethod(store, "recordTerminalReceipt");
  const getEvent = assertMethod(store, "getEvent");
  const readEventTail = assertMethod(store, "readEventTail");
  const readDeliveryState = assertMethod(store, "readDeliveryState");
  const targets = assertTargets(ownValue(options, "deliveryTargets"));
  const deliver = ownValue(options, "deliver");
  if (typeof deliver !== "function") {
    fail("INVALID_CONFIGURATION", "Monitor durability bridge requires deliver()");
  }

  return Object.freeze({
    async persistEvent(event, config = {}) {
      const validatedEvent = assertEnvelope(event, "forge.memory.monitor-event.v1");
      const persistenceEvent = immutableSnapshot(validatedEvent, "monitor persistence event");
      const deliveryEvent = immutableSnapshot(validatedEvent, "monitor delivery event");
      const safeConfig = immutableSnapshot(config, "monitor persistence config");
      const persistence = await providerCall(() => appendEvent(persistenceEvent, targets, safeConfig));
      try {
        const delivery = await deliver(deliveryEvent, targets);
        return Object.freeze({ persistence, delivery });
      } catch (error) {
        fail("DELIVERY_FAILED", "Monitor delivery failed after durable persistence", {
          persisted: true,
          eventId: persistenceEvent.payload.event_id,
          cause: error,
        });
      }
    },

    async acknowledgeDelivery(monitorId, receipt, config = {}) {
      const safeMonitorId = assertMonitorId(monitorId);
      const safeReceipt = immutableSnapshot(
        assertEnvelope(receipt, "forge.memory.delivery-receipt.v1"),
        "monitor delivery receipt",
      );
      const safeConfig = immutableSnapshot(config, "monitor acknowledgement config");
      if (!targets.includes(safeReceipt.payload.target)) {
        fail("INPUT_INVALID", "Delivery receipt target is outside the monitor targets");
      }
      const event = assertEvent(
        await providerCall(() => getEvent(safeReceipt.payload.event_id, safeConfig)),
        safeMonitorId,
        safeReceipt.payload.event_id,
      );
      const deliveryState = assertDeliveryState(
        await providerCall(() => readDeliveryState(
          safeMonitorId,
          { limit: MAX_EVIDENCE_HISTORY },
          safeConfig,
        )),
        safeMonitorId,
      );
      const cursor = deliveryState.cursors.find(({ target }) => target === safeReceipt.payload.target);
      if (cursor && cursor.sequence > event.sequence) {
        fail("STALE_CURSOR", "Monitor delivery cursor is stale");
      }
      const persistence = await providerCall(() => recordDeliveryReceipt(safeReceipt, safeConfig));
      return Object.freeze({ persistence, sequence: event.sequence });
    },

    async recordTerminalReceipt(receipt, config = {}) {
      const safeReceipt = immutableSnapshot(
        assertEnvelope(receipt, "forge.memory.monitor-receipt.v1"),
        "monitor terminal receipt",
      );
      const safeConfig = immutableSnapshot(config, "monitor terminal config");
      const maxHistory = assertHistoryWidth(safeConfig);
      const monitorId = safeReceipt.payload.monitor_id;
      const deliveryState = assertDeliveryState(
        await providerCall(() => readDeliveryState(
          monitorId,
          { limit: MAX_EVIDENCE_HISTORY },
          safeConfig,
        )),
        monitorId,
      );
      if (deliveryState.terminal) {
        if (deliveryState.terminal.content_hash !== safeReceipt.content_hash) {
          fail("IDENTITY_CONFLICT", "Monitor identity/content conflict");
        }
        const persistence = await providerCall(() => recordTerminalReceipt(safeReceipt, safeConfig));
        return Object.freeze({ persistence });
      }
      const rows = assertTail(
        await providerCall(() => readEventTail(monitorId, { limit: maxHistory }, safeConfig)),
        monitorId,
        maxHistory,
      );
      assertTerminalEvidence(safeReceipt, rows, maxHistory);
      const persistence = await providerCall(() => recordTerminalReceipt(safeReceipt, safeConfig));
      return Object.freeze({ persistence });
    },
  });
}

module.exports = { MonitorDurabilityError, createMonitorDurabilityBridge };
