'use strict';

const { createHash } = require('node:crypto');

const RESULT_STATUSES = Object.freeze(['PASS', 'INCOMPLETE']);
const AVAILABILITY_STATUSES = Object.freeze(['AVAILABLE', 'UNAVAILABLE']);
const CAPABILITY_STATUSES = Object.freeze(['AVAILABLE', 'UNAVAILABLE', 'INCOMPLETE']);

function assertEnum(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new TypeError(`${field} must be one of: ${allowed.join(', ')}`);
  }
}

function assertOptionalString(value, field) {
  if (value !== null && (typeof value !== 'string' || value.length === 0)) {
    throw new TypeError(`${field} must be null or a non-empty string`);
  }
}

function normalizeCapability(capability) {
  if (!capability || typeof capability !== 'object' || Array.isArray(capability)) {
    throw new TypeError('capability must be an object');
  }
  if (typeof capability.id !== 'string' || capability.id.length === 0) {
    throw new TypeError('capability.id must be a non-empty string');
  }
  if (typeof capability.available !== 'boolean') {
    throw new TypeError('capability.available must be a boolean');
  }
  assertEnum(capability.status, CAPABILITY_STATUSES, 'capability.status');
  if (typeof capability.reason !== 'string' || capability.reason.length === 0) {
    throw new TypeError('capability.reason must be a non-empty string');
  }
  if (typeof capability.probe_id !== 'string' || capability.probe_id.length === 0) {
    throw new TypeError('capability.probe_id must be a non-empty string');
  }
  if (capability.available !== (capability.status === 'AVAILABLE')) {
    throw new TypeError('capability.available must agree with capability.status');
  }
  return {
    id: capability.id,
    available: capability.available,
    status: capability.status,
    reason: capability.reason,
    probe_id: capability.probe_id,
  };
}

function compareIds(left, right) {
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

function hashProjection(result) {
  return {
    schema_version: result.schema_version,
    probe_revision: result.probe_revision,
    harness_id: result.harness_id,
    status: result.status,
    availability: result.availability,
    executable: {
      command: result.executable.command,
      identity: result.executable.identity,
      version: result.executable.version,
    },
    capabilities: result.capabilities
      .map(normalizeCapability)
      .sort(compareIds),
  };
}

function computeProbeResultHash(result) {
  return createHash('sha256')
    .update(JSON.stringify(hashProjection(result)), 'utf8')
    .digest('hex');
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function createProbeResult(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('probe result input must be an object');
  }
  if (typeof input.harnessId !== 'string' || input.harnessId.length === 0) {
    throw new TypeError('harnessId must be a non-empty string');
  }
  if (typeof input.probeRevision !== 'string' || input.probeRevision.length === 0) {
    throw new TypeError('probeRevision must be a non-empty string');
  }
  assertEnum(input.status, RESULT_STATUSES, 'status');
  assertEnum(input.availability, AVAILABILITY_STATUSES, 'availability');
  if (!input.executable || typeof input.executable !== 'object' || Array.isArray(input.executable)) {
    throw new TypeError('executable must be an object');
  }
  if (typeof input.executable.command !== 'string' || input.executable.command.length === 0) {
    throw new TypeError('executable.command must be a non-empty string');
  }
  assertOptionalString(input.executable.identity, 'executable.identity');
  assertOptionalString(input.executable.version, 'executable.version');
  if (!Array.isArray(input.capabilities)) {
    throw new TypeError('capabilities must be an array');
  }
  const observedAt = new Date(input.observedAt);
  if (!Number.isFinite(observedAt.getTime())) {
    throw new TypeError('observedAt must be a valid timestamp');
  }

  const result = {
    schema_version: 1,
    probe_revision: input.probeRevision,
    harness_id: input.harnessId,
    status: input.status,
    availability: input.availability,
    observed_at: observedAt.toISOString(),
    executable: {
      command: input.executable.command,
      identity: input.executable.identity,
      version: input.executable.version,
    },
    capabilities: input.capabilities.map(normalizeCapability)
      .sort(compareIds),
  };
  result.result_hash = computeProbeResultHash(result);
  return deepFreeze(result);
}

module.exports = {
  AVAILABILITY_STATUSES,
  CAPABILITY_STATUSES,
  RESULT_STATUSES,
  computeProbeResultHash,
  createProbeResult,
};
