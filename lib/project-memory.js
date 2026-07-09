'use strict';

const { resolveKernelDatabasePath } = require('./kernel/cli-broker-factory');
const { createBuiltinSQLiteDriver } = require('./kernel/sqlite-driver');

// Project memory is a Forge read model persisted in the kernel store (kernel_memories),
// written DIRECTLY rather than through the issue CAS/guarded-event path. The store seam
// (options.store) is a driver-like object — { recordMemory, loadMemory, searchMemories,
// listMemories } — so hermetic tests stay in-memory. The default seam resolves the
// per-repo kernel database path and reuses one driver per database path (the CLI process
// is short-lived, so the connection closing on exit is sufficient cleanup).

const storeCache = new Map();

function defaultStore(projectRoot, options = {}) {
  const databasePath = resolveKernelDatabasePath({
    projectRoot,
    gitCommonDir: options.gitCommonDir,
    databasePath: options.databasePath,
  });
  let store = storeCache.get(databasePath);
  if (!store) {
    store = createBuiltinSQLiteDriver({ databasePath });
    storeCache.set(databasePath, store);
  }
  return store;
}

function resolveStore(projectRoot, options = {}) {
  return options.store ?? defaultStore(projectRoot, options);
}

function assertEntryObject(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new TypeError('project memory entry must be an object');
  }
}

function assertRequiredString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`project memory entry ${fieldName} is required`);
  }
}

function assertStringArray(value, fieldName) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new TypeError(`project memory entry ${fieldName} must be an array of strings`);
  }
}

function assertOptionalConfidence(value) {
  if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) {
    throw new TypeError('project memory entry confidence must be a number from 0 to 1');
  }
}

function validateEntry(entry) {
  assertEntryObject(entry);
  assertRequiredString(entry.key, 'key');
  if (!Object.hasOwn(entry, 'value') || entry.value === undefined) {
    throw new TypeError('project memory entry value is required');
  }
  assertRequiredString(entry.sourceAgent || entry['source-agent'], 'sourceAgent');
  if (entry.timestamp !== undefined
    && (typeof entry.timestamp !== 'string' || Number.isNaN(Date.parse(entry.timestamp)))) {
    throw new TypeError('project memory entry timestamp must be an ISO timestamp string');
  }
  if (entry.scope !== undefined && (typeof entry.scope !== 'string' || entry.scope.trim() === '')) {
    throw new TypeError('project memory entry scope must be a non-empty string');
  }
  assertOptionalConfidence(entry.confidence);
  if (entry.tags !== undefined) assertStringArray(entry.tags, 'tags');
  if (entry.supersedes !== undefined) assertStringArray(entry.supersedes, 'supersedes');
  if (entry.beadsRefs !== undefined) assertStringArray(entry.beadsRefs, 'beadsRefs');
  if (entry['beads-refs'] !== undefined) assertStringArray(entry['beads-refs'], 'beads-refs');
}

// Canonicalize an entry for storage: resolve the snake-case input aliases, default the
// timestamp and tags, and carry the optional fields only when present (so the persisted
// shape matches the legacy entry exactly).
function normalizeEntry(key, entry) {
  const normalized = {
    key,
    value: entry.value,
    sourceAgent: entry.sourceAgent || entry['source-agent'],
    tags: Array.isArray(entry.tags) ? [...entry.tags] : [],
    timestamp: entry.timestamp ?? new Date().toISOString(),
  };

  if (entry.scope !== undefined) normalized.scope = entry.scope;
  if (entry.confidence !== undefined) normalized.confidence = entry.confidence;
  if (entry.supersedes !== undefined) normalized.supersedes = [...entry.supersedes];
  if (entry.beadsRefs !== undefined || entry['beads-refs'] !== undefined) {
    normalized.beadsRefs = [...(entry.beadsRefs || entry['beads-refs'])];
  }

  return normalized;
}

function write(projectRoot, entry, options = {}) {
  validateEntry(entry);
  const normalized = normalizeEntry(entry.key.trim(), entry);
  resolveStore(projectRoot, options).recordMemory(normalized);
  return normalized;
}

function read(projectRoot, key, options = {}) {
  assertRequiredString(key, 'read key');
  return resolveStore(projectRoot, options).loadMemory(key.trim());
}

function search(projectRoot, query, options = {}) {
  if (typeof query !== 'string' || query.trim() === '') {
    return [];
  }
  return resolveStore(projectRoot, options).searchMemories(query.trim());
}

function list(projectRoot, options = {}) {
  return resolveStore(projectRoot, options).listMemories();
}

// The newest `limit` entries (default recall with no query). Delegates to the FTS-backed
// driver so recall never loads and re-sorts the whole table.
function recent(projectRoot, limit, options = {}) {
  return resolveStore(projectRoot, options).recentMemories(limit);
}

// Total stored memories — paired with `recent` so recall can report "showing N of TOTAL".
function count(projectRoot, options = {}) {
  return resolveStore(projectRoot, options).countMemories();
}

// BM25 top-N recall over the FTS5 index (token-AND). Unlike `search` (the legacy LIKE
// helper) this does not short-circuit an empty query — the driver falls back to recent so
// recall stays capped either way.
function searchRanked(projectRoot, query, limit, options = {}) {
  return resolveStore(projectRoot, options).searchMemoriesRanked(query, limit);
}

// Close and forget every cached default store. The CLI process is short-lived (the OS
// closes the handle on exit), so this is mainly a lifecycle helper for long-lived hosts and
// tests — it releases the SQLite/WAL handle before a temp dir is removed.
function closeAll() {
  for (const store of storeCache.values()) {
    try {
      if (store && typeof store.close === 'function') store.close();
    } catch {
      // best-effort close
    }
  }
  storeCache.clear();
}

module.exports = {
  read,
  write,
  search,
  list,
  recent,
  count,
  searchRanked,
  closeAll,
};
