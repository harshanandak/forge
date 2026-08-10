'use strict';

const { ContractValidationError, validateContractStructure } = require('@forge/memory-contracts');

const TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const SECRET_PATTERN = /(?:gh[pousr]_[A-Za-z0-9]{20,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S{8,})/i;
const ABSOLUTE_USER_PATH = /(?:[A-Za-z]:[\\/]Users[\\/][^\\/\s]+(?:[\\/]|$)|\/(?:Users|home)\/[^/\s]+(?:\/|$))/i;
const MAX_TARGETS = 32;
const MAX_TARGET_LENGTH = 128;

function assertEnvelope(envelope, schemaId) {
  const result = validateContractStructure(envelope);
  if (!result.ok || envelope?.schema_id !== schemaId) {
    throw new ContractValidationError(result.ok
      ? [{ path: '$.schema_id', code: 'UNEXPECTED_SCHEMA' }]
      : result.errors);
  }
  return envelope;
}

function assertTarget(target) {
  if (typeof target !== 'string' || target.length === 0 || target.length > MAX_TARGET_LENGTH
    || !TARGET_PATTERN.test(target) || SECRET_PATTERN.test(target) || ABSOLUTE_USER_PATH.test(target)) {
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
  createMonitorStore,
};
