'use strict';

const { buildSharedIssueRecord } = require('./schema.js');
const {
  GITHUB_OWNED_FIELD_PATHS,
  cloneValue,
} = require('./github-pull.js');

const MAX_DRIFT_HISTORY = 50;

function readField(record, fieldPath) {
  switch (fieldPath) {
    case 'github.number':
      return record.github.number;
    case 'github.nodeId':
      return record.github.nodeId;
    case 'github.url':
      return record.github.url;
    case 'shared.title':
      return record.shared.title;
    case 'shared.body':
      return record.shared.body;
    case 'shared.state':
      return record.shared.state;
    case 'shared.assignees':
      return record.shared.assignees;
    case 'shared.labels':
      return record.shared.labels;
    case 'shared.milestone':
      return record.shared.milestone;
    case 'sync.remoteUpdatedAt':
      return record.sync.remoteUpdatedAt;
    default:
      return undefined;
  }
}

function writeField(record, fieldPath, value) {
  switch (fieldPath) {
    case 'github.number':
      record.github.number = value;
      break;
    case 'github.nodeId':
      record.github.nodeId = value;
      break;
    case 'github.url':
      record.github.url = value;
      break;
    case 'shared.title':
      record.shared.title = value;
      break;
    case 'shared.body':
      record.shared.body = value;
      break;
    case 'shared.state':
      record.shared.state = value;
      break;
    case 'shared.assignees':
      record.shared.assignees = value;
      break;
    case 'shared.labels':
      record.shared.labels = value;
      break;
    case 'shared.milestone':
      record.shared.milestone = value;
      break;
    case 'sync.remoteUpdatedAt':
      record.sync.remoteUpdatedAt = value;
      break;
    default:
      break;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepEqual(left, right) {
  if (left === right) {
    return true;
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return false;
    }

    for (let index = 0; index < left.length; index += 1) {
      if (!deepEqual(left[index], right[index])) {
        return false;
      }
    }

    return true;
  }

  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);

    if (leftKeys.length !== rightKeys.length) {
      return false;
    }

    for (const key of leftKeys) {
      if (!Object.hasOwn(right, key) || !deepEqual(left[key], right[key])) {
        return false;
      }
    }

    return true;
  }

  return false;
}

function createDriftDiagnostic(field, localValue, remoteValue) {
  return {
    type: 'github-shared-drift',
    field,
    localValue: cloneValue(localValue),
    remoteValue: cloneValue(remoteValue),
  };
}

function buildMaterializedIssueSnapshot(record) {
  const snapshot = cloneValue(record);

  if (snapshot?.cache) {
    snapshot.cache.materializedIssue = null;
  }

  return snapshot;
}

function mergeDriftDiagnostics(existingDiagnostics = [], newDiagnostics = []) {
  const merged = [];
  const seen = new Set();

  for (const diagnostic of [...existingDiagnostics, ...newDiagnostics]) {
    const clonedDiagnostic = cloneValue(diagnostic);
    const key = JSON.stringify(clonedDiagnostic);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    merged.push(clonedDiagnostic);
  }

  return merged.slice(-MAX_DRIFT_HISTORY);
}

function reconcileSharedIssueRecord(localRecord = {}, remoteSnapshot = {}, options = {}) {
  const existingRecord = buildSharedIssueRecord(localRecord);
  const remoteRecord = buildSharedIssueRecord(remoteSnapshot);
  const reconciledRecord = buildSharedIssueRecord(existingRecord);
  const diagnostics = [];

  for (const fieldPath of GITHUB_OWNED_FIELD_PATHS) {
    const localValue = readField(existingRecord, fieldPath);
    const remoteValue = readField(remoteRecord, fieldPath);

    if (!deepEqual(localValue, remoteValue)) {
      diagnostics.push(createDriftDiagnostic(fieldPath, localValue, remoteValue));
    }

    writeField(reconciledRecord, fieldPath, cloneValue(remoteValue));
  }

  // Some import/materialization flows need to retain the last local pull
  // watermark instead of overwriting it with the fresh GitHub timestamp.
  if (options.preserveRemoteUpdatedAt === false && existingRecord.sync.remoteUpdatedAt !== null) {
    reconciledRecord.sync.remoteUpdatedAt = existingRecord.sync.remoteUpdatedAt;
  }

  reconciledRecord.sync.drift = mergeDriftDiagnostics(existingRecord.sync.drift ?? [], diagnostics);
  reconciledRecord.cache.githubSnapshot = cloneValue(remoteSnapshot);
  reconciledRecord.cache.materializedIssue = buildMaterializedIssueSnapshot(reconciledRecord);

  return {
    record: reconciledRecord,
    diagnostics,
  };
}

module.exports = {
  buildMaterializedIssueSnapshot,
  createDriftDiagnostic,
  deepEqual,
  reconcileSharedIssueRecord,
  readField,
  writeField,
};
