'use strict';

const { types: { isProxy } } = require('node:util');

// Public, storage-agnostic contract for bounded durable-memory usage evidence.
const USE_KINDS = Object.freeze(['cli-recall', 'prompt-injection', 'read-attention', 'session-digest']);
const MAX_IDENTIFIER_LENGTH = 255;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/i;
const SQLITE_CONTENTION_CODES = new Set(['SQLITE_BUSY', 'SQLITE_LOCKED']);

const USAGE_EVIDENCE_MIGRATION = Object.freeze({
  id: '011_memory_usage_evidence',
  additive: true,
  rollback_mode: 'disable-writes-preserve-evidence',
  apply: Object.freeze([
    `CREATE TABLE IF NOT EXISTS memory_usage_writer_state (
  singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
);`,
    'INSERT OR IGNORE INTO memory_usage_writer_state (singleton, enabled) VALUES (1, 1);',
    `CREATE TABLE IF NOT EXISTS memory_usage_events (
  event_id TEXT NOT NULL PRIMARY KEY,
  memory_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  use_kind TEXT NOT NULL,
  consumer_id TEXT NOT NULL,
  selection_digest TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE
);`,
    'CREATE INDEX IF NOT EXISTS idx_memory_usage_events_memory_observed ON memory_usage_events(memory_id, observed_at);',
    `CREATE TABLE IF NOT EXISTS memory_usage_projection (
  scope TEXT NOT NULL,
  memory_id TEXT NOT NULL PRIMARY KEY,
  last_used_at TEXT NOT NULL,
  use_count INTEGER NOT NULL CHECK (typeof(use_count) = 'integer' AND use_count >= 0)
);`,
    'CREATE INDEX IF NOT EXISTS idx_memory_usage_projection_scope_last_used_memory ON memory_usage_projection(scope, last_used_at, memory_id);',
  ]),
  rollback: Object.freeze(['UPDATE memory_usage_writer_state SET enabled = 0 WHERE singleton = 1;']),
});

class UsageIdempotencyConflictError extends Error {
  constructor(idempotencyKey) {
    super(`usage evidence idempotency key conflicts: ${idempotencyKey}`);
    this.name = 'UsageIdempotencyConflictError';
  }
}

class UsageMemoryScopeConflictError extends Error {
  constructor(memoryId) {
    super(`usage evidence memory scope conflicts: ${memoryId}`);
    this.name = 'UsageMemoryScopeConflictError';
  }
}

function assertAdapter(store, method) {
  return ownDataMethod(store, method, 'store');
}

function ownDataMethod(value, method, subject = 'adapter') {
  if (!value || typeof value !== 'object' || isProxy(value)) {
    throw new TypeError(`usage evidence ${subject} must be a plain record`);
  }
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(value, method); } catch { throw new TypeError(`usage evidence ${subject} ${method} must be an own data property`); }
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
    throw new TypeError(`usage evidence ${subject} ${method} must be an own data property`);
  }
  return descriptor.value;
}

function optionalOwnDataMethod(value, method, subject = 'store') {
  if (!value || typeof value !== 'object' || isProxy(value)) {
    throw new TypeError(`usage evidence ${subject} must be a plain record`);
  }
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(value, method); } catch { throw new TypeError(`usage evidence ${subject} ${method} must be an own data property`); }
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
    throw new TypeError(`usage evidence ${subject} ${method} must be an own data property`);
  }
  return descriptor.value;
}

function assertOpaqueIdentifier(value, fieldName) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH
    || /[\\/]/.test(value) || [...value].some(character => character.charCodeAt(0) < 32)) {
    throw new TypeError(`usage evidence ${fieldName} must be a bounded opaque identifier`);
  }
}

function assertObservedAt(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError('usage evidence observed_at must be a canonical ISO timestamp');
  }
}

function readOwnDataProperty(input, fieldName) {
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(input, fieldName); } catch { throw new TypeError(`usage evidence ${fieldName} must be an own data property`); }
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError(`usage evidence ${fieldName} must be an own data property`);
  return descriptor.value;
}

function normalizeUsageEvidence(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('usage evidence must be an object');
  const event = Object.fromEntries(['event_id', 'memory_id', 'scope', 'use_kind', 'consumer_id', 'selection_digest', 'observed_at', 'idempotency_key']
    .map(field => [field, readOwnDataProperty(input, field)]));
  for (const fieldName of ['event_id', 'memory_id', 'scope', 'consumer_id', 'idempotency_key']) assertOpaqueIdentifier(event[fieldName], fieldName);
  if (!USE_KINDS.includes(event.use_kind)) throw new TypeError(`usage evidence use_kind must be one of: ${USE_KINDS.join(', ')}`);
  if (typeof event.selection_digest !== 'string' || !DIGEST_PATTERN.test(event.selection_digest)) throw new TypeError('usage evidence selection_digest must be a SHA-256 digest');
  assertObservedAt(event.observed_at);
  return event;
}

function installUsageEvidenceSchema(store) {
  const exec = assertAdapter(store, 'exec');
  for (const statement of USAGE_EVIDENCE_MIGRATION.apply) exec.call(store, statement);
}

function sameUsageEvidence(left, right) {
  return ['event_id', 'memory_id', 'scope', 'use_kind', 'consumer_id', 'selection_digest', 'observed_at', 'idempotency_key']
    .every(field => left[field] === right[field]);
}

function loadProjection(one, store, event) {
  return one.call(store, 'SELECT last_used_at, use_count FROM memory_usage_projection WHERE memory_id = ?', [event.memory_id]);
}

function runTransactionWithSingleContentionRetry(transaction, store, callback) {
  try { return transaction.call(store, callback); } catch (error) {
    if (!SQLITE_CONTENTION_CODES.has(error?.code)) throw error;
    return transaction.call(store, callback);
  }
}

function assertWriterEnabled(writerGuard, store) {
  if (writerGuard) writerGuard.call(store);
}

function appendUsageEvidence(store, input) {
  const transaction = assertAdapter(store, 'transaction');
  const one = assertAdapter(store, 'one');
  const run = assertAdapter(store, 'run');
  const writerGuard = optionalOwnDataMethod(store, 'assertUsageWriterEnabled');
  const event = normalizeUsageEvidence(input);
  return runTransactionWithSingleContentionRetry(transaction, store, () => {
    assertWriterEnabled(writerGuard, store);
    const existing = one.call(store, `SELECT event_id, memory_id, scope, use_kind, consumer_id, selection_digest, observed_at, idempotency_key
      FROM memory_usage_events WHERE idempotency_key = ?`, [event.idempotency_key]);
    if (existing) {
      if (!sameUsageEvidence(existing, event)) throw new UsageIdempotencyConflictError(event.idempotency_key);
      return { appended: false, ...loadProjection(one, store, event) };
    }
    const conflictingEvent = one.call(store, 'SELECT scope FROM memory_usage_events WHERE memory_id = ? AND scope <> ? LIMIT 1', [event.memory_id, event.scope]);
    const existingProjection = one.call(store, 'SELECT scope FROM memory_usage_projection WHERE memory_id = ?', [event.memory_id]);
    if (conflictingEvent || (existingProjection && existingProjection.scope !== event.scope)) throw new UsageMemoryScopeConflictError(event.memory_id);
    run.call(store, `INSERT INTO memory_usage_events (event_id, memory_id, scope, use_kind, consumer_id, selection_digest, observed_at, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [event.event_id, event.memory_id, event.scope, event.use_kind, event.consumer_id, event.selection_digest, event.observed_at, event.idempotency_key]);
    run.call(store, `INSERT INTO memory_usage_projection (scope, memory_id, last_used_at, use_count) VALUES (?, ?, ?, 1)
      ON CONFLICT(memory_id) DO UPDATE SET last_used_at = MAX(memory_usage_projection.last_used_at, excluded.last_used_at), use_count = memory_usage_projection.use_count + 1`,
    [event.scope, event.memory_id, event.observed_at]);
    return { appended: true, ...loadProjection(one, store, event) };
  });
}

function rebuildUsageProjection(store) {
  const transaction = assertAdapter(store, 'transaction');
  const exec = assertAdapter(store, 'exec');
  const one = assertAdapter(store, 'one');
  const writerGuard = optionalOwnDataMethod(store, 'assertUsageWriterEnabled');
  return runTransactionWithSingleContentionRetry(transaction, store, () => {
    assertWriterEnabled(writerGuard, store);
    const conflict = one.call(store, `SELECT memory_id FROM memory_usage_events GROUP BY memory_id HAVING COUNT(DISTINCT scope) > 1 LIMIT 1`);
    if (conflict) throw new UsageMemoryScopeConflictError(conflict.memory_id);
    exec.call(store, 'DELETE FROM memory_usage_projection');
    exec.call(store, `INSERT INTO memory_usage_projection (scope, memory_id, last_used_at, use_count)
      SELECT MIN(scope), memory_id, MAX(observed_at), COUNT(*) FROM memory_usage_events GROUP BY memory_id`);
    return { projections: Number(one.call(store, 'SELECT COUNT(*) AS count FROM memory_usage_projection').count) };
  });
}

function createUsageEvidenceStore(driver) {
  const append = ownDataMethod(driver, 'appendUsageEvidence', 'adapter');
  const rebuild = ownDataMethod(driver, 'rebuildUsageProjection', 'adapter');
  const projection = ownDataMethod(driver, 'loadUsageProjection', 'adapter');
  const projections = ownDataMethod(driver, 'loadUsageProjections', 'adapter');
  return Object.freeze({
    append: (event, config = {}) => append.call(driver, normalizeUsageEvidence(event), config),
    rebuild: (config = {}) => rebuild.call(driver, config),
    projection: (memoryId, config = {}) => {
      assertOpaqueIdentifier(memoryId, 'memory_id');
      return projection.call(driver, memoryId, config);
    },
    projections: (memoryIds, config = {}) => {
      if (!Array.isArray(memoryIds) || memoryIds.length > 200) throw new TypeError('usage evidence memory ids must be a bounded array');
      const unique = [...new Set(memoryIds)];
      unique.forEach(memoryId => assertOpaqueIdentifier(memoryId, 'memory_id'));
      return projections.call(driver, unique, config);
    },
  });
}

module.exports = { USE_KINDS, USAGE_EVIDENCE_MIGRATION, UsageIdempotencyConflictError, UsageMemoryScopeConflictError, appendUsageEvidence, createUsageEvidenceStore, installUsageEvidenceSchema, normalizeUsageEvidence, rebuildUsageProjection };
