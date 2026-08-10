'use strict';

// Private adapter seam for durable usage evidence. The kernel driver wires this module
// separately so existing memory reads retain their current behaviour until that wiring lands.
// Its transaction(callback) implementation must serialize writes (SQLite: BEGIN IMMEDIATE).
const USE_KINDS = Object.freeze([
  'cli-recall',
  'prompt-injection',
  'read-attention',
  'session-digest',
]);
const MAX_IDENTIFIER_LENGTH = 255;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/i;
const SQLITE_CONTENTION_CODES = new Set(['SQLITE_BUSY', 'SQLITE_LOCKED']);

const USAGE_EVIDENCE_MIGRATION = Object.freeze({
  id: 'memory-usage-evidence-v1',
  additive: true,
  rollback: 'disable-writes-preserve-evidence',
  statements: Object.freeze([
    `CREATE TABLE IF NOT EXISTS memory_usage_events (
      event_id TEXT NOT NULL PRIMARY KEY,
      memory_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      use_kind TEXT NOT NULL,
      consumer_id TEXT NOT NULL,
      selection_digest TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE
    )`,
    'CREATE INDEX IF NOT EXISTS idx_memory_usage_events_memory_observed ON memory_usage_events(memory_id, observed_at)',
    `CREATE TABLE IF NOT EXISTS memory_usage_projection (
      scope TEXT NOT NULL,
      memory_id TEXT NOT NULL PRIMARY KEY,
      last_used_at TEXT NOT NULL,
      use_count INTEGER NOT NULL CHECK (typeof(use_count) = 'integer' AND use_count >= 0)
    )`,
    'CREATE INDEX IF NOT EXISTS idx_memory_usage_projection_scope_last_used_memory ON memory_usage_projection(scope, last_used_at, memory_id)',
  ]),
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
  if (!store || typeof store[method] !== 'function') {
    throw new TypeError(`usage evidence store must implement ${method}()`);
  }
}

function assertOpaqueIdentifier(value, fieldName) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH
    || /[\\/]/.test(value) || [...value].some(character => character.charCodeAt(0) < 32)) {
    throw new TypeError(`usage evidence ${fieldName} must be a bounded opaque identifier`);
  }
}

function assertObservedAt(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new TypeError('usage evidence observed_at must be a canonical ISO timestamp');
  }
}

function readOwnDataProperty(input, fieldName) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(input, fieldName);
  } catch {
    throw new TypeError(`usage evidence ${fieldName} must be an own data property`);
  }
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
    throw new TypeError(`usage evidence ${fieldName} must be an own data property`);
  }
  return descriptor.value;
}

function normalizeUsageEvidence(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('usage evidence must be an object');
  }
  const event = {
    event_id: readOwnDataProperty(input, 'event_id'),
    memory_id: readOwnDataProperty(input, 'memory_id'),
    scope: readOwnDataProperty(input, 'scope'),
    use_kind: readOwnDataProperty(input, 'use_kind'),
    consumer_id: readOwnDataProperty(input, 'consumer_id'),
    selection_digest: readOwnDataProperty(input, 'selection_digest'),
    observed_at: readOwnDataProperty(input, 'observed_at'),
    idempotency_key: readOwnDataProperty(input, 'idempotency_key'),
  };
  for (const fieldName of ['event_id', 'memory_id', 'scope', 'consumer_id', 'idempotency_key']) {
    assertOpaqueIdentifier(event[fieldName], fieldName);
  }
  if (!USE_KINDS.includes(event.use_kind)) {
    throw new TypeError(`usage evidence use_kind must be one of: ${USE_KINDS.join(', ')}`);
  }
  if (typeof event.selection_digest !== 'string' || !DIGEST_PATTERN.test(event.selection_digest)) {
    throw new TypeError('usage evidence selection_digest must be a SHA-256 digest');
  }
  assertObservedAt(event.observed_at);
  return event;
}

function installUsageEvidenceSchema(store) {
  assertAdapter(store, 'exec');
  for (const statement of USAGE_EVIDENCE_MIGRATION.statements) store.exec(statement);
}

function sameUsageEvidence(left, right) {
  return left.event_id === right.event_id
    && left.memory_id === right.memory_id
    && left.scope === right.scope
    && left.use_kind === right.use_kind
    && left.consumer_id === right.consumer_id
    && left.selection_digest === right.selection_digest
    && left.observed_at === right.observed_at
    && left.idempotency_key === right.idempotency_key;
}

function loadProjection(store, event) {
  return store.one(
    'SELECT last_used_at, use_count FROM memory_usage_projection WHERE memory_id = ?',
    [event.memory_id],
  );
}

function runTransactionWithSingleContentionRetry(store, callback) {
  try {
    return store.transaction(callback);
  } catch (error) {
    if (!SQLITE_CONTENTION_CODES.has(error?.code)) throw error;
    return store.transaction(callback);
  }
}

function appendUsageEvidence(store, input) {
  assertAdapter(store, 'transaction');
  assertAdapter(store, 'one');
  assertAdapter(store, 'run');
  const event = normalizeUsageEvidence(input);
  return runTransactionWithSingleContentionRetry(store, () => {
    const existing = store.one(
      `SELECT event_id, memory_id, scope, use_kind, consumer_id, selection_digest, observed_at, idempotency_key
       FROM memory_usage_events WHERE idempotency_key = ?`,
      [event.idempotency_key],
    );
    if (existing) {
      if (!sameUsageEvidence(existing, event)) {
        throw new UsageIdempotencyConflictError(event.idempotency_key);
      }
      return { appended: false, ...loadProjection(store, event) };
    }
    const conflictingEvent = store.one(
      'SELECT scope FROM memory_usage_events WHERE memory_id = ? AND scope <> ? LIMIT 1',
      [event.memory_id, event.scope],
    );
    const existingProjection = store.one(
      'SELECT scope FROM memory_usage_projection WHERE memory_id = ?',
      [event.memory_id],
    );
    if (conflictingEvent || (existingProjection && existingProjection.scope !== event.scope)) {
      throw new UsageMemoryScopeConflictError(event.memory_id);
    }
    store.run(
      `INSERT INTO memory_usage_events (
        event_id, memory_id, scope, use_kind, consumer_id, selection_digest, observed_at, idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.event_id,
        event.memory_id,
        event.scope,
        event.use_kind,
        event.consumer_id,
        event.selection_digest,
        event.observed_at,
        event.idempotency_key,
      ],
    );
    store.run(
      `INSERT INTO memory_usage_projection (scope, memory_id, last_used_at, use_count)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(memory_id) DO UPDATE SET
         last_used_at = MAX(memory_usage_projection.last_used_at, excluded.last_used_at),
         use_count = memory_usage_projection.use_count + 1`,
      [event.scope, event.memory_id, event.observed_at],
    );
    return { appended: true, ...loadProjection(store, event) };
  });
}

function rebuildUsageProjection(store) {
  assertAdapter(store, 'transaction');
  assertAdapter(store, 'exec');
  assertAdapter(store, 'one');
  return runTransactionWithSingleContentionRetry(store, () => {
    const conflict = store.one(`SELECT memory_id
      FROM memory_usage_events
      GROUP BY memory_id
      HAVING COUNT(DISTINCT scope) > 1
      LIMIT 1`);
    if (conflict) throw new UsageMemoryScopeConflictError(conflict.memory_id);
    store.exec('DELETE FROM memory_usage_projection');
    store.exec(`INSERT INTO memory_usage_projection (scope, memory_id, last_used_at, use_count)
      SELECT MIN(scope), memory_id, MAX(observed_at), COUNT(*)
      FROM memory_usage_events
      GROUP BY memory_id`);
    return { projections: Number(store.one('SELECT COUNT(*) AS count FROM memory_usage_projection').count) };
  });
}

module.exports = {
  USE_KINDS,
  USAGE_EVIDENCE_MIGRATION,
  UsageIdempotencyConflictError,
  UsageMemoryScopeConflictError,
  appendUsageEvidence,
  installUsageEvidenceSchema,
  normalizeUsageEvidence,
  rebuildUsageProjection,
};
