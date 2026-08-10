'use strict';

const { ContractValidationError, validateContractStructure } = require('@forge/memory-contracts');

const TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const SECRET_PATTERNS = [
  /gh[pousr]_[a-z0-9]{20,}/i,
  /github_pat_[a-z0-9_]{20,}/i,
  /sk_(?:live|test)_[a-z0-9]{16,}/i,
  /sk-[a-z0-9]{16,}/i,
  /AKIA[0-9A-Z]{16}/i,
  /(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S{8,}/i,
];
const MAX_TARGETS = 32;
const MAX_TARGET_LENGTH = 128;
const PRIVATE_PATH_ROOTS = ['users', 'home', 'root'];
const MAX_PRIVATE_SCAN_LENGTH = 16_384;

function hasNonWhitespacePathSegment(segment) {
  return Boolean(segment && segment.trim());
}

function containsPrivateMonitorPath(value) {
  if (typeof value !== 'string') return false;
  if (value.length > MAX_PRIVATE_SCAN_LENGTH) return true;
  const normalized = value.replaceAll('\\', '/').toLowerCase();
  for (const root of PRIVATE_PATH_ROOTS) {
    const marker = `/${root}/`;
    let offset = 0;
    while (true) {
      const index = normalized.indexOf(marker, offset);
      if (index < 0) break;
      const segment = normalized.slice(index + marker.length).split('/')[0];
      if (hasNonWhitespacePathSegment(segment)) return true;
      offset = index + marker.length;
    }
  }
  for (let code = 97; code <= 122; code += 1) {
    const marker = `${String.fromCharCode(code)}:/users/`;
    const index = normalized.indexOf(marker);
    if (index >= 0 && hasNonWhitespacePathSegment(
      normalized.slice(index + marker.length).split('/')[0],
    )) return true;
  }
  return false;
}

function containsPrivateMonitorData(value) {
  if (typeof value === 'string') {
    return SECRET_PATTERNS.some(pattern => pattern.test(value)) || containsPrivateMonitorPath(value);
  }
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, nestedValue]) => (
    SECRET_PATTERNS.some(pattern => pattern.test(key))
    || containsPrivateMonitorPath(key)
    || containsPrivateMonitorData(nestedValue)
  ));
}

function assertEnvelope(envelope, schemaId) {
  const result = validateContractStructure(envelope);
  if (!result.ok || envelope?.schema_id !== schemaId) {
    throw new ContractValidationError(result.ok
      ? [{ path: '$.schema_id', code: 'UNEXPECTED_SCHEMA' }]
      : result.errors);
  }
  const privacyEnvelope = schemaId === 'forge.memory.delivery-receipt.v1' && envelope?.payload
    ? { ...envelope, payload: { ...envelope.payload, target: '' } }
    : envelope;
  if (containsPrivateMonitorData(privacyEnvelope)) {
    throw new Error(`private content rejected from ${schemaId}`);
  }
  return envelope;
}

function assertTarget(target) {
  if (typeof target !== 'string' || target.length === 0 || target.length > MAX_TARGET_LENGTH
    || !TARGET_PATTERN.test(target) || SECRET_PATTERNS.some(pattern => pattern.test(target)) || containsPrivateMonitorPath(target)) {
    throw new Error('invalid or private monitor delivery target');
  }
  return target;
}

function normalizeTargets(targets) {
  if (!Array.isArray(targets) || targets.length === 0 || targets.length > MAX_TARGETS) {
    throw new Error(`monitor delivery targets must contain 1-${MAX_TARGETS} entries`);
  }
  return [...new Set(targets.map(assertTarget))];
}

function createMonitorStore(driver) {
  if (!driver || typeof driver.appendMonitorEvent !== 'function') {
    throw new Error('Monitor store requires a monitor-capable SQLite driver');
  }
  return {
    async appendEvent(envelope, targets, config = {}) {
      assertEnvelope(envelope, 'forge.memory.monitor-event.v1');
      return driver.appendMonitorEvent(envelope, normalizeTargets(targets), config);
    },
    async recordDeliveryReceipt(envelope, config = {}) {
      assertEnvelope(envelope, 'forge.memory.delivery-receipt.v1');
      assertTarget(envelope.payload.target);
      return driver.recordMonitorDeliveryReceipt(envelope, config);
    },
    async recordTerminalReceipt(envelope, config = {}) {
      assertEnvelope(envelope, 'forge.memory.monitor-receipt.v1');
      return driver.recordMonitorTerminalReceipt(envelope, config);
    },
    listEvents(monitorId, config = {}) {
      if (typeof monitorId !== 'string' || !monitorId) throw new Error('monitorId is required');
      return driver.listMonitorEvents(monitorId, config);
    },
  };
}

module.exports = {
  ...require('./src/authority-provider'),
  ...require('./src/backend-registry'),
  ...require('./src/feedback-intake'),
  ...require('./src/usage-evidence'),
  createMonitorStore,
};
