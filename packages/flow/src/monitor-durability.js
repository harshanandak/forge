"use strict";

const { types } = require("node:util");
const {
  canonicalize,
  computeContentHash,
} = require("@forge/memory-contracts");

const MAX_EVENTS_PER_RECEIPT = 4096;
const MAX_INPUT_BYTES = 1_048_576;
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

function assertEnvelope(value, schemaId) {
  const snapshot = snapshotCanonical(value, schemaId);
  const computedHash = snapshot && typeof snapshot === "object"
    ? computeContentHash(snapshot)
    : undefined;
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
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index].sequence !== index) {
      fail("INCOMPLETE_TERMINAL_EVIDENCE", "Monitor event history has a sequence gap");
    }
  }
  return rows;
}

function assertPassEvidence(receipt, rows) {
  if (receipt.payload.terminal_state !== "PASS") return;
  if (rows.length === 0 || rows.at(-1).sequence !== receipt.payload.last_sequence) {
    fail("INCOMPLETE_TERMINAL_EVIDENCE", "PASS receipt does not cover durable monitor events");
  }
  const digest = computeContentHash({ evidence_hashes: rows.map((row) => row.content_hash) });
  if (digest !== receipt.payload.evidence_digest) {
    fail("INCOMPLETE_TERMINAL_EVIDENCE", "PASS receipt evidence digest is incomplete");
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
      const safeEvent = assertEnvelope(event, "forge.memory.monitor-event.v1");
      const safeConfig = snapshotCanonical(config, "monitor persistence config");
      const persistence = await providerCall(() => appendEvent(safeEvent, targets, safeConfig));
      try {
        const delivery = await deliver(safeEvent, targets);
        return Object.freeze({ persistence, delivery });
      } catch {
        fail("DELIVERY_FAILED", "Monitor delivery failed after durable persistence", {
          persisted: true,
          eventId: safeEvent.payload.event_id,
        });
      }
    },

    async acknowledgeDelivery(monitorId, receipt, config = {}) {
      if (typeof monitorId !== "string" || monitorId.length === 0) {
        fail("INPUT_INVALID", "monitorId is required for delivery acknowledgement");
      }
      const safeReceipt = assertEnvelope(receipt, "forge.memory.delivery-receipt.v1");
      const safeConfig = snapshotCanonical(config, "monitor acknowledgement config");
      if (!targets.includes(safeReceipt.payload.target)) {
        fail("INPUT_INVALID", "Delivery receipt target is outside the monitor targets");
      }
      const rows = assertRows(await providerCall(() => listEvents(monitorId, safeConfig)), monitorId);
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
      assertPassEvidence(safeReceipt, rows);
      const persistence = await providerCall(() => recordTerminalReceipt(safeReceipt, safeConfig));
      return Object.freeze({ persistence });
    },
  });
}

module.exports = { MonitorDurabilityError, createMonitorDurabilityBridge };
