"use strict";

const { types } = require("node:util");
const {
  canonicalize,
  computeContentHash,
  validateContractStructure,
} = require("@forge/memory-contracts");

const MAX_EVENTS_PER_RECEIPT = 4096;
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

function mapProviderFailure(error) {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("conflict")) {
    return new MonitorDurabilityError("IDENTITY_CONFLICT", "Monitor identity/content conflict");
  }
  if (message.includes("stale") && message.includes("cursor")) {
    return new MonitorDurabilityError("STALE_CURSOR", "Monitor delivery cursor is stale");
  }
  if (message.includes("stale") && message.includes("terminal")) {
    return new MonitorDurabilityError(
      "INCOMPLETE_TERMINAL_EVIDENCE",
      "Monitor terminal evidence is stale",
    );
  }
  return new MonitorDurabilityError("PROVIDER_UNAVAILABLE", "Monitor durability provider unavailable");
}

async function providerCall(operation) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof MonitorDurabilityError) throw error;
    throw mapProviderFailure(error);
  }
}

function assertRows(value, monitorId) {
  const snapshot = snapshotCanonical(value, "monitor event history");
  if (!Array.isArray(snapshot) || snapshot.length > MAX_EVENTS_PER_RECEIPT) {
    fail("INCOMPLETE_TERMINAL_EVIDENCE", "Monitor event history is unavailable or exceeds its bound");
  }
  const rows = snapshot.map((row) => {
    if (
      !row ||
      typeof row !== "object" ||
      row.monitor_id !== monitorId ||
      !Number.isSafeInteger(row.sequence) ||
      row.sequence < 0 ||
      typeof row.event_id !== "string" ||
      !SHA256.test(row.content_hash)
    ) {
      fail("INCOMPLETE_TERMINAL_EVIDENCE", "Monitor event history is incomplete");
    }
    return row;
  });
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index].sequence <= rows[index - 1].sequence) {
      fail("INCOMPLETE_TERMINAL_EVIDENCE", "Monitor event history is not monotonic");
    }
  }
  return rows;
}

function assertTerminalEvidence(receipt, rows) {
  const terminalState = receipt.payload.terminal_state;
  if (terminalState !== "PASS" && terminalState !== "FAIL") return;
  const evidenceRows = rows.slice(-MAX_EVIDENCE_HISTORY);
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
  const listEvents = assertMethod(store, "listEvents");
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
      } catch {
        fail("DELIVERY_FAILED", "Monitor delivery failed after durable persistence", {
          persisted: true,
          eventId: persistenceEvent.payload.event_id,
        });
      }
    },

    async acknowledgeDelivery(monitorId, receipt, config = {}) {
      const safeMonitorId = assertMonitorId(monitorId);
      const safeReceipt = assertEnvelope(receipt, "forge.memory.delivery-receipt.v1");
      const safeConfig = snapshotCanonical(config, "monitor acknowledgement config");
      if (!targets.includes(safeReceipt.payload.target)) {
        fail("INPUT_INVALID", "Delivery receipt target is outside the monitor targets");
      }
      const rows = assertRows(await providerCall(() => listEvents(safeMonitorId, safeConfig)), safeMonitorId);
      const event = rows.find((row) => row.event_id === safeReceipt.payload.event_id);
      if (!event) fail("INPUT_INVALID", "Delivery receipt references an unknown monitor event");
      const persistence = await providerCall(() => recordDeliveryReceipt(safeReceipt, safeConfig));
      return Object.freeze({ persistence, sequence: event.sequence });
    },

    async recordTerminalReceipt(receipt, config = {}) {
      const safeReceipt = assertEnvelope(receipt, "forge.memory.monitor-receipt.v1");
      const safeConfig = snapshotCanonical(config, "monitor terminal config");
      const monitorId = safeReceipt.payload.monitor_id;
      const rows = assertRows(await providerCall(() => listEvents(monitorId, safeConfig)), monitorId);
      assertTerminalEvidence(safeReceipt, rows);
      const persistence = await providerCall(() => recordTerminalReceipt(safeReceipt, safeConfig));
      return Object.freeze({ persistence });
    },
  });
}

module.exports = { MonitorDurabilityError, createMonitorDurabilityBridge };
