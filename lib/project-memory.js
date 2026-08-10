'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { types: { isProxy } } = require('node:util');
const { resolveKernelDatabasePath } = require('./kernel/cli-broker-factory');
const { resolveGitCommonDir } = require('./kernel/broker');
const { createBuiltinSQLiteDriver } = require('./kernel/sqlite-driver');
const { normalizeRecallHit } = require('./memory-recall');
const { createUsageEvidenceStore } = require('../packages/memory');

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

function resolveProjectId(projectRoot, options = {}) {
  const platform = options.platform || process.platform;
  const pathImpl = platform === 'win32' ? path.win32 : path.posix;
  const commonDir = options.gitCommonDir || resolveGitCommonDir(projectRoot, options);
  const absolute = pathImpl.resolve(projectRoot, commonDir);
  const realpath = options.realpath || fs.realpathSync.native;
  let canonical;
  try {
    canonical = realpath(absolute);
  } catch {
    canonical = absolute;
  }
  canonical = canonical.replaceAll('\\', '/');
  return platform === 'win32'
    ? canonical.toLowerCase()
    : canonical;
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
// driver so recall never loads and re-sorts the whole table. `options.agents` (a
// source_agent allow-list) scopes the read, e.g. to human `remember` notes only.
function recent(projectRoot, limit, options = {}) {
  return resolveStore(projectRoot, options).recentMemories(limit, {
    agents: options.agents,
    kind: options.kind,
  });
}

// Total stored memories (optionally scoped by `options.agents`) — paired with `recent` so
// recall can report "showing N of TOTAL".
function count(projectRoot, options = {}) {
  return resolveStore(projectRoot, options).countMemories({
    agents: options.agents,
    kind: options.kind,
  });
}

// BM25 top-N recall over the FTS5 index (token-AND). Unlike `search` (the legacy LIKE
// helper) this does not short-circuit an empty query — the driver falls back to recent so
// recall stays capped either way.
function searchRanked(projectRoot, query, limit, options = {}) {
  return resolveStore(projectRoot, options).searchMemoriesRanked(query, limit, {
    kind: options.kind,
  });
}

// Relevance-only BM25 recall that returns the raw bm25 `score` per entry, so a caller can
// apply a relevance floor. A no-match/empty query returns [] (no recency fallback). The
// per-turn memory-recall hook uses this to inject nothing unless a note clearly matches.
function searchRankedScored(projectRoot, query, limit, options = {}) {
  const projectId = resolveProjectId(projectRoot, options);
  const searchOptions = {
    projectId,
    excludeKeys: options.excludeKeys || [],
    ...(options.now ? { now: options.now } : {}),
    ...(options.busyTimeoutMs !== undefined ? { busyTimeoutMs: options.busyTimeoutMs } : {}),
  };
  return resolveStore(projectRoot, options)
    .searchMemoriesRankedScored(query, limit, searchOptions)
    .map(hit => normalizeRecallHit(hit, projectId));
}

function opaqueUsageIdentity(kind, value) {
  return createHash('sha256').update(`${kind}\0${value}`).digest('hex');
}

function memoryUsageIdentity(key) {
  return opaqueUsageIdentity('forge.memory.key.v1', key);
}

function ownDataValue(value, field) {
  if (!value || typeof value !== 'object' || isProxy(value)) return undefined;
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(value, field); } catch { return undefined; }
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function usageResolutionOptions(options) {
  const resolutionOptions = {};
  for (const field of ['store', 'gitCommonDir', 'platform', 'realpath', 'databasePath']) {
    const option = ownDataValue(options, field);
    if (option !== undefined) resolutionOptions[field] = option;
  }
  return resolutionOptions;
}

function usageInvocationId(options) {
  const value = ownDataValue(options, 'invocationId');
  return typeof value === 'string' && value ? value : randomUUID();
}

function usageObservedAt(options) {
  const invocationStartedAt = ownDataValue(options, 'invocationStartedAt');
  if (typeof invocationStartedAt === 'string') return invocationStartedAt;
  const now = ownDataValue(options, 'now');
  if (typeof now === 'string') return now;
  return new Date().toISOString();
}

function usageMemoryIdentities(notes) {
  return notes
    .map(note => ownDataValue(note, 'id'))
    .filter(id => typeof id === 'string' && id.length > 0)
    .map(memoryUsageIdentity);
}

function appendRecallUsage(store, identities, invocationId, scope, selectionDigest, observedAt) {
  let appended = 0;
  let failed = 0;
  for (const memoryId of identities) {
    try {
      const result = store.append({
        event_id: opaqueUsageIdentity('forge.memory.used.event.v1', `${invocationId}\0${memoryId}`),
        memory_id: memoryId,
        scope,
        use_kind: 'cli-recall',
        consumer_id: 'cli-recall',
        selection_digest: selectionDigest,
        observed_at: observedAt,
        idempotency_key: opaqueUsageIdentity('forge.memory.used.idempotency.v1', `${invocationId}\0${memoryId}`),
      });
      if (result?.appended) appended += 1;
    } catch {
      // Evidence is advisory: a storage failure must never hide a useful recall.
      failed += 1;
    }
  }
  return { attempted: identities.length, appended, failed };
}

// Recall evidence deliberately accepts only the returned note identifiers. It hashes those
// identifiers immediately, so neither a user path, query, nor note content can reach storage.
function recordRecallUsage(projectRoot, selected, options = {}) {
  const notes = Array.isArray(selected) ? selected : [];
  if (notes.length === 0) return { attempted: 0, appended: 0, failed: 0 };
  const usageStore = ownDataValue(options, 'usageStore');
  const resolutionOptions = usageResolutionOptions(options);
  const invocationId = usageInvocationId(options);
  const observedAt = usageObservedAt(options);
  const identities = usageMemoryIdentities(notes);
  if (identities.length === 0) return { attempted: 0, appended: 0, failed: 0 };
  let scope;
  let selectionDigest;
  let store;
  try {
    scope = opaqueUsageIdentity('forge.memory.scope.v1', resolveProjectId(projectRoot, resolutionOptions));
    selectionDigest = opaqueUsageIdentity('forge.memory.selection.v1', identities.join('\0'));
    store = createUsageEvidenceStore(usageStore || resolveStore(projectRoot, resolutionOptions));
  } catch {
    return { attempted: identities.length, appended: 0, failed: identities.length };
  }
  return appendRecallUsage(store, identities, invocationId, scope, selectionDigest, observedAt);
}

function usageProjection(projectRoot, key, options = {}) {
  if (typeof key !== 'string' || !key) return null;
  try {
    const usageStore = ownDataValue(options, 'usageStore');
    return createUsageEvidenceStore(usageStore || resolveStore(projectRoot, options))
      .projection(opaqueUsageIdentity('forge.memory.key.v1', key));
  } catch {
    return null;
  }
}

function usageProjectionStatus(projectRoot, keys, options = {}) {
  if (!Array.isArray(keys) || keys.length === 0) return { available: true, projections: new Map() };
  const rawKeys = [...new Set(keys.filter(key => typeof key === 'string' && key))].slice(0, 200);
  if (rawKeys.length === 0) return { available: true, projections: new Map() };
  const usageStore = ownDataValue(options, 'usageStore');
  const identities = rawKeys.map(memoryUsageIdentity);
  try {
    const rows = createUsageEvidenceStore(usageStore || resolveStore(projectRoot, options)).projections(identities);
    const keyByIdentity = new Map(rawKeys.map((key, index) => [identities[index], key]));
    return {
      available: true,
      projections: new Map(rows.map(row => [keyByIdentity.get(row.memory_id), row]).filter(([key]) => key)),
    };
  } catch {
    return { available: false, projections: new Map() };
  }
}

function usageProjections(projectRoot, keys, options = {}) {
  return usageProjectionStatus(projectRoot, keys, options).projections;
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
  searchRankedScored,
  recordRecallUsage,
  usageProjection,
  usageProjectionStatus,
  usageProjections,
  memoryUsageIdentity,
  resolveStore,
  resolveProjectId,
  closeAll,
};
